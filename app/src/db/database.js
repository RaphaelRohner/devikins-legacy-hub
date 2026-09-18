/**
 * database.js
 *
 * Everything related to talking to the local SQLite database lives here.
 * No other file in the app should import `expo-sqlite` directly - they
 * should call functions from this file instead. That way, if we ever need
 * to change HOW data is stored, we only have to change it in one place.
 *
 * expo-sqlite basics for readers new to this library:
 *   - openDatabaseAsync(name) opens (or creates) a database file on the
 *     phone's storage, identified by a plain filename.
 *   - execAsync(sql) runs SQL that doesn't need parameters (like CREATE
 *     TABLE statements).
 *   - runAsync(sql, params) runs SQL with `?` placeholders filled in by
 *     `params` - this is how we safely insert data without worrying about
 *     special characters breaking the query.
 *   - getAllAsync(sql, params) runs a SELECT and gives back every matching
 *     row as a plain JavaScript array of objects.
 */

import * as SQLite from 'expo-sqlite';
import { TRAIT_COLUMNS } from '../constants/schema';

const DATABASE_FILE_NAME = 'devikins.db';

// We only want to open the database once and reuse the same connection
// everywhere, rather than re-opening it every time some part of the app
// wants to read or write. This variable caches that one open connection.
let databaseConnectionPromise = null;

function getDatabase() {
  if (!databaseConnectionPromise) {
    databaseConnectionPromise = SQLite.openDatabaseAsync(DATABASE_FILE_NAME);
  }
  return databaseConnectionPromise;
}

// Turns { rarity: { kind: 'text' }, scaling: { kind: 'integer' }, ... }
// into the column-definition part of a CREATE TABLE statement, e.g.
// "rarity TEXT, scaling INTEGER". This means the SQL columns always match
// exactly what's declared in schema.js - there's no second list to keep in
// sync by hand.
function buildTraitColumnDefinitions(kind) {
  const columns = TRAIT_COLUMNS[kind];
  return Object.entries(columns)
    .map(([columnName, def]) => `${columnName} ${def.kind === 'integer' ? 'INTEGER' : 'TEXT'}`)
    .join(',\n      ');
}

/**
 * Creates the three tables (devikin, weapon, equipment) if they don't
 * already exist. Safe to call every time the app starts - CREATE TABLE IF
 * NOT EXISTS does nothing if the table is already there, so this never
 * erases existing data.
 */
// Adds a column to an already-existing table if it isn't there yet. Used
// for small schema changes made after the app was already in use on
// someone's phone, where CREATE TABLE IF NOT EXISTS alone wouldn't help -
// that only runs the CREATE the very first time a table doesn't exist at
// all, so a brand new column added to that statement later would never
// actually get added to a database file that already has the table.
async function ensureColumn(db, table, columnName, columnType) {
  try {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnType}`);
  } catch (err) {
    // SQLite throws if the column is already there - that just means
    // this migration already ran on a previous app start, which is fine.
    if (!/duplicate column name/i.test(err.message)) {
      throw err;
    }
  }
}

export async function initDatabase() {
  const db = await getDatabase();
  for (const kind of Object.keys(TRAIT_COLUMNS)) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${kind} (
        nonce INTEGER PRIMARY KEY NOT NULL,
        owner_address TEXT,
        name TEXT,
        image TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'failed',
        fetched_at INTEGER,
        raw_json TEXT,
        ${buildTraitColumnDefinitions(kind)}
      );
    `);

    // Added after the app was already storing data on real phones - see
    // ensureColumn's comment above for why this can't just live in the
    // CREATE TABLE statement above. Holds a local file:// path to a
    // downloaded copy of this NFT's image (see src/api/imageStorage.js),
    // so the picture is available even if the image's original host is
    // slow or briefly unreachable.
    await ensureColumn(db, kind, 'local_image_path', 'TEXT');

    // "Deleted" here doesn't mean the row is actually removed from the
    // database - it's a soft flag the user sets themselves from an NFT's
    // detail view (see NftCard.js's "Mark as Deleted" button) to hide
    // something from their own view (sold it, don't care about it any
    // more, etc) without losing the data or making it hard to undo.
    // `comment` is a free-text note that goes with it (also editable from
    // that same detail view) - e.g. "sold on marketplace 2026-09".
    // DEFAULT 0 means every already-existing row picks up "not deleted"
    // automatically the moment this migration runs, with no separate
    // backfill needed.
    await ensureColumn(db, kind, 'deleted', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, kind, 'comment', 'TEXT');
  }

  // A tiny generic key/value table for small bits of app state that
  // isn't NFT data. These days that's nothing load-bearing any more (the
  // wallet list below replaced the one thing this used to store), but
  // it's kept around since it costs nothing and something else may want
  // it later.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
  `);

  // Every wallet address the user has added, via the Wallets management
  // screen (see WalletManager.js) - Fetch/Update now loops over every row
  // in this table rather than working with just one address at a time.
  // `address` is UNIQUE so adding the same address twice by mistake is
  // harmless (see addWallet below, which uses INSERT OR IGNORE).
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      created_at INTEGER
    );
  `);
  // Optional friendly name for a wallet (e.g. "Main" or "Trading"),
  // editable from the Wallets screen - see updateWalletAddress below.
  // Added after the wallets table itself already existed on real
  // phones, so it goes through the same safe/no-op-if-already-there
  // ensureColumn helper as the NFT tables' own added-later columns do.
  await ensureColumn(db, 'wallets', 'alias', 'TEXT');

  // One-time migration: before this multi-wallet feature existed, the app
  // only ever remembered a single address (in the settings table above,
  // under the 'lastWalletAddress' key) - and there's real NFT data in the
  // devikin/weapon/equipment tables already tagged with that address as
  // its owner_address. Without this, upgrading to this version would make
  // that data seem to vanish (nothing in `wallets` yet = nothing to show)
  // even though it's all still sitting right there in the database. So:
  // if the wallets table is still completely empty AND there's a
  // remembered single address from before, carry it over automatically,
  // exactly once.
  const existingWalletCount = await db.getFirstAsync(`SELECT COUNT(*) AS count FROM wallets`);
  if ((existingWalletCount?.count ?? 0) === 0) {
    const previousSingleAddress = await getSetting('lastWalletAddress');
    if (previousSingleAddress) {
      await db.runAsync(
        `INSERT OR IGNORE INTO wallets (address, created_at) VALUES (?, ?)`,
        [previousSingleAddress, Date.now()]
      );
    }
  }
}

/**
 * Reads one value from the settings table (see initDatabase above).
 * Returns null if the key has never been set.
 */
export async function getSetting(key) {
  const db = await getDatabase();
  const row = await db.getFirstAsync(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row?.value ?? null;
}

/**
 * Saves one value into the settings table, overwriting any previous
 * value for that key.
 */
export async function setSetting(key, value) {
  const db = await getDatabase();
  await db.runAsync(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
}

/**
 * Every saved wallet address, oldest first (so newly-added ones show up
 * at the bottom of the Wallets screen's list, in the order they were
 * added). Used by App.js (to know what to fetch and what to query NFTs
 * by) and WalletManager.js (to actually show/edit/delete them).
 */
export async function getWallets() {
  const db = await getDatabase();
  return db.getAllAsync(`SELECT id, address, alias, created_at FROM wallets ORDER BY id ASC`);
}

/**
 * Adds one wallet address. INSERT OR IGNORE means adding the same address
 * twice (by mistake, or because it was already there) is completely
 * harmless - it just silently does nothing the second time, rather than
 * erroring over the UNIQUE constraint. `address` is trimmed first so a
 * stray leading/trailing space doesn't create a "duplicate" that looks
 * identical but doesn't match on future lookups.
 */
export async function addWallet(address) {
  const db = await getDatabase();
  const trimmedAddress = address.trim();
  await db.runAsync(
    `INSERT OR IGNORE INTO wallets (address, created_at) VALUES (?, ?)`,
    [trimmedAddress, Date.now()]
  );
}

/**
 * Changes an existing wallet's address and/or its optional friendly
 * alias (the "Save" in the Wallets screen's edit mode) - e.g. fixing a
 * typo after adding it, or giving it a name like "Main" or "Trading" so
 * it's easier to tell wallets apart at a glance. Note this does NOT move
 * any already-fetched NFT data over to the new address - the old
 * address's rows in the devikin/weapon/equipment tables keep their
 * original owner_address. In practice this is fine for fixing a genuine
 * typo (a mistyped address never successfully fetched anything in the
 * first place), but editing a working address into a DIFFERENT wallet's
 * address is really the same as deleting the old one and adding the new
 * one, not an edit. An empty/blank alias is stored as null (no name),
 * not an empty string, so "does this wallet have a name?" is a simple
 * truthy check everywhere else in the app.
 */
export async function updateWalletAddress(id, address, alias) {
  const db = await getDatabase();
  const trimmedAddress = address.trim();
  const trimmedAlias = typeof alias === 'string' ? alias.trim() : '';
  await db.runAsync(
    `UPDATE wallets SET address = ?, alias = ? WHERE id = ?`,
    [trimmedAddress, trimmedAlias || null, id]
  );
}

/**
 * Removes one wallet from the list. This only stops it from being
 * fetched/shown going forward - any NFTs already saved under that
 * address stay in the database untouched (just no longer visible, since
 * nothing filters them in any more). Re-adding the same address later
 * would make them reappear.
 */
export async function deleteWallet(id) {
  const db = await getDatabase();
  await db.runAsync(`DELETE FROM wallets WHERE id = ?`, [id]);
}

/**
 * Wipes every wallet and every saved NFT (across all three collections),
 * back to exactly the state a brand-new install starts in - used by the
 * "Reset All Data" button in WalletManager.js (see its own comment for
 * why that exists). Deliberately just empties the tables rather than
 * dropping/recreating them - the schema itself (columns, the `wallets`
 * table, etc.) is untouched, so there's nothing for initDatabase's
 * migrations to redo. Doesn't touch the `settings` table on purpose -
 * that only ever held one-time migration bookkeeping (see initDatabase
 * above), not user data, so clearing it would just make that old
 * migration attempt to run again pointlessly.
 */
export async function resetAllData() {
  const db = await getDatabase();
  await db.runAsync(`DELETE FROM devikin`);
  await db.runAsync(`DELETE FROM weapon`);
  await db.runAsync(`DELETE FROM equipment`);
  await db.runAsync(`DELETE FROM wallets`);
}

/**
 * Builds a safe "owner_address IN (...)" SQL fragment (with matching
 * params) for however many wallet addresses are currently active. Used
 * by every query below that needs to match NFTs belonging to ANY of the
 * user's saved wallets, not just one. An empty list deliberately builds
 * a clause that matches nothing (rather than an invalid empty "IN ()",
 * which SQLite would reject) - that correctly means "no wallets saved
 * yet, so no NFTs to show".
 */
function ownerAddressClause(ownerAddresses) {
  if (!ownerAddresses || ownerAddresses.length === 0) {
    return { clause: '0 = 1', params: [] };
  }
  const placeholders = ownerAddresses.map(() => '?').join(', ');
  return { clause: `owner_address IN (${placeholders})`, params: [...ownerAddresses] };
}

/**
 * Looks up the current `status` for a batch of nonces in one collection,
 * so the fetch process can decide which ones to skip (see
 * fetchAllForWallet.js). Returns a plain object like { "123": "ok", "456":
 * "unavailable" } - nonces with no existing row simply won't appear in the
 * result, which the caller treats as "never fetched before".
 *
 * SQLite has a limit on how many `?` placeholders a single query can have
 * (usually 999), so for wallets with a huge number of NFTs we split the
 * lookup into chunks rather than risk hitting that limit.
 */
export async function getExistingStatuses(kind, nonces) {
  if (nonces.length === 0) return {};

  const db = await getDatabase();
  const CHUNK_SIZE = 500;
  const statusByNonce = {};

  for (let start = 0; start < nonces.length; start += CHUNK_SIZE) {
    const chunk = nonces.slice(start, start + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.getAllAsync(
      `SELECT nonce, status FROM ${kind} WHERE nonce IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      statusByNonce[row.nonce] = row.status;
    }
  }

  return statusByNonce;
}

/**
 * Saves (or updates) one NFT's row. This is the only place that writes
 * NFT data, and it's deliberately defensive:
 *
 *   - If `metadata` is null (the fetch failed or the NFT doesn't exist),
 *     we still record the row with just a status, so we remember not to
 *     keep hammering a dead nonce.
 *   - Every trait_type found in metadata.attributes is matched against
 *     the known columns for this collection (from schema.js). A match
 *     fills in that column. No match gets logged to the console (so a
 *     developer notices the game added a new trait) but is NEVER lost,
 *     because...
 *   - ...the complete original API response is always saved as-is in the
 *     raw_json column, regardless of whether every field also got its own
 *     column. If our column list is ever wrong or incomplete, no data is
 *     gone - it's sitting in raw_json waiting to be re-parsed.
 */
export async function upsertNft(kind, { nonce, ownerAddress, status, metadata, localImagePath = null }) {
  const db = await getDatabase();
  const traitColumns = TRAIT_COLUMNS[kind];

  // IMPORTANT BUG FIX: a transient failure on a RE-fetch must never erase
  // data we already have. Before this check existed, if an NFT had
  // previously been fetched successfully (status 'ok', with its image and
  // traits saved) and a later Fetch happened to hit one of the metadata
  // API's routine timeouts for that specific item, this function would
  // overwrite the good row with a blank one (status 'failed', every
  // column null) - permanently losing data over a purely temporary
  // hiccup. That's almost certainly why the app appeared to show
  // "different results every time": every Fetch had a chance of quietly
  // wiping out a few previously-good items.
  //
  // The fix: if this is a transient-failure write (status 'failed', no
  // metadata) and we already have a good ('ok') row for this nonce, do
  // nothing at all - leave the existing good data exactly as it is. The
  // next Fetch will simply try again.
  if (status === 'failed' && !metadata) {
    const existingRow = await db.getFirstAsync(
      `SELECT status FROM ${kind} WHERE nonce = ?`,
      [nonce]
    );
    if (existingRow && existingRow.status === 'ok') {
      return;
    }
  }

  // Build a lookup from the raw trait_type spelling (as the API sends it)
  // to our column name, e.g. "Improvement Level" -> "improvement_level"
  // and "ImprovementLevel" -> "improvement_level" (same column, both
  // collections' spelling of the same idea).
  const traitTypeToColumn = {};
  for (const [columnName, def] of Object.entries(traitColumns)) {
    for (const rawTraitType of def.traitTypes) {
      traitTypeToColumn[rawTraitType] = columnName;
    }
  }

  // Start every known trait column as null, then fill in whatever this
  // particular NFT actually has. Not every NFT necessarily has every
  // trait, so columns that don't get touched here correctly stay null.
  const traitValues = {};
  for (const columnName of Object.keys(traitColumns)) {
    traitValues[columnName] = null;
  }

  let name = null;
  let image = null;
  let description = null;

  if (metadata) {
    name = metadata.name ?? null;
    image = metadata.image ?? null;
    description = metadata.description ?? null;

    if (Array.isArray(metadata.attributes)) {
      for (const attribute of metadata.attributes) {
        const columnName = traitTypeToColumn[attribute.trait_type];
        if (columnName) {
          traitValues[columnName] = attribute.value ?? null;
        } else {
          console.log(
            `[database] ${kind} #${nonce} has a trait_type we don't have a column for: "${attribute.trait_type}" ` +
            `(value: ${JSON.stringify(attribute.value)}). It's still safe inside raw_json, but consider adding ` +
            `a column for it in src/constants/schema.js.`
          );
        }
      }
    }
  }

  const traitColumnNames = Object.keys(traitColumns);
  const allColumnNames = ['nonce', 'owner_address', 'name', 'image', 'local_image_path', 'description', 'status', 'fetched_at', 'raw_json', ...traitColumnNames];
  const placeholders = allColumnNames.map(() => '?').join(', ');

  const params = [
    nonce,
    ownerAddress,
    name,
    image,
    localImagePath,
    description,
    status,
    Date.now(),
    metadata ? JSON.stringify(metadata) : null,
    ...traitColumnNames.map((columnName) => traitValues[columnName]),
  ];

  // INSERT OR REPLACE: since `nonce` is the table's PRIMARY KEY, this
  // either creates a brand-new row, or completely overwrites the existing
  // row for that nonce with fresh data. That's exactly what we want for
  // re-fetching - since NFT stats can change over time (see NOTES.md),
  // the newest fetch should always win.
  await db.runAsync(
    `INSERT OR REPLACE INTO ${kind} (${allColumnNames.join(', ')}) VALUES (${placeholders})`,
    params
  );
}

/**
 * Returns the distinct values currently stored for one text column, for
 * building a dropdown filter. Only looks at rows belonging to ANY of the
 * given wallet addresses and with status 'ok' (no point offering
 * "Rarity: null" as a filter option for NFTs whose data we couldn't
 * fetch).
 */
export async function getDistinctColumnValues(kind, columnName, ownerAddresses) {
  const db = await getDatabase();
  const { clause, params } = ownerAddressClause(ownerAddresses);
  const rows = await db.getAllAsync(
    `SELECT DISTINCT ${columnName} AS value FROM ${kind}
     WHERE ${clause} AND status = 'ok' AND ${columnName} IS NOT NULL
     ORDER BY ${columnName} ASC`,
    params
  );
  return rows.map((row) => row.value);
}

/**
 * Returns the [min, max] currently stored for one numeric column, for
 * showing the actual range in a range filter's placeholder text.
 */
export async function getColumnRange(kind, columnName, ownerAddresses) {
  const db = await getDatabase();
  const { clause, params } = ownerAddressClause(ownerAddresses);
  const row = await db.getFirstAsync(
    `SELECT MIN(${columnName}) AS min, MAX(${columnName}) AS max FROM ${kind}
     WHERE ${clause} AND status = 'ok' AND ${columnName} IS NOT NULL`,
    params
  );
  return { min: row?.min ?? null, max: row?.max ?? null };
}

/**
 * The main query used to populate the on-screen list. `filters` is a plain
 * object built by the filter UI, e.g.:
 *   { rarity: 'Rare', scaling: { min: 50, max: 100 } }
 * Any trait left out of `filters` is not filtered on at all.
 *
 * Rows with status 'unavailable' or 'failed' ARE included (with mostly-
 * empty fields) so the user can see "this one exists but has no details"
 * rather than the NFT just silently disappearing from their list.
 *
 * `excludeDeleted` is the "Deleted" switch in CollectionView.js - when
 * true, anything marked deleted is left out of the results entirely
 * (rather than just shown greyed-out, which is what happens when this is
 * false - see the summary row components for that styling).
 */
export async function queryNfts(kind, ownerAddresses, filters = {}, excludeDeleted = false) {
  const db = await getDatabase();
  const traitColumns = TRAIT_COLUMNS[kind];

  const { clause, params: ownerParams } = ownerAddressClause(ownerAddresses);
  const whereClauses = [clause];
  const params = [...ownerParams];

  if (excludeDeleted) {
    whereClauses.push(`(deleted IS NULL OR deleted = 0)`);
  }

  for (const [columnName, filterValue] of Object.entries(filters)) {
    if (filterValue === undefined || filterValue === null || filterValue === '') continue;
    const columnDef = traitColumns[columnName];
    if (!columnDef) continue; // ignore anything that isn't a real column, just in case

    if (columnDef.kind === 'text') {
      whereClauses.push(`${columnName} = ?`);
      params.push(filterValue);
    } else {
      // Numeric range filter: { min, max } - either side is optional.
      if (filterValue.min !== undefined && filterValue.min !== null && filterValue.min !== '') {
        whereClauses.push(`${columnName} >= ?`);
        params.push(Number(filterValue.min));
      }
      if (filterValue.max !== undefined && filterValue.max !== null && filterValue.max !== '') {
        whereClauses.push(`${columnName} <= ?`);
        params.push(Number(filterValue.max));
      }
    }
  }

  const sql = `SELECT * FROM ${kind} WHERE ${whereClauses.join(' AND ')} ORDER BY nonce ASC`;
  return db.getAllAsync(sql, params);
}

/**
 * Simple counts for the empty-state / tab-badge logic: how many rows
 * across the given wallets this collection has, regardless of filters.
 */
export async function countNfts(kind, ownerAddresses, excludeDeleted = false) {
  const db = await getDatabase();
  const { clause, params: ownerParams } = ownerAddressClause(ownerAddresses);
  const whereClauses = [clause];
  const params = [...ownerParams];

  if (excludeDeleted) {
    whereClauses.push(`(deleted IS NULL OR deleted = 0)`);
  }

  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM ${kind} WHERE ${whereClauses.join(' AND ')}`,
    params
  );
  return row?.count ?? 0;
}

/**
 * Marks (or un-marks) one NFT as deleted, with an optional note attached -
 * see NftCard.js's "Mark as Deleted"/"Restore" buttons at the bottom of
 * every detail view. This is a soft flag, not a real delete - nothing is
 * removed from the database, and it's always reversible.
 */
export async function setNftDeletedState(kind, nonce, deleted, comment) {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE ${kind} SET deleted = ?, comment = ? WHERE nonce = ?`,
    [deleted ? 1 : 0, comment, nonce]
  );
}

/**
 * Nonces stuck in 'failed' status for one collection - the metadata
 * fetch never succeeded for these. Used by the automatic retry timer
 * (see fetchAllForWallet.js's retryPendingItems and App.js) so it can
 * retry exactly the items that need it without re-asking the blockchain
 * what the wallet holds.
 */
export async function getFailedNonces(kind, ownerAddress) {
  const db = await getDatabase();
  const rows = await db.getAllAsync(
    `SELECT nonce FROM ${kind} WHERE owner_address = ? AND status = 'failed'`,
    [ownerAddress]
  );
  return rows.map((row) => row.nonce);
}

/**
 * Rows that fetched successfully (we have a remote image URL) but never
 * got a locally-cached copy of that image - e.g. the metadata request
 * succeeded but the image download itself failed or timed out. Returns
 * both the nonce and the remote URL, since that's all retrying the image
 * alone needs (no need to re-fetch the metadata itself).
 */
export async function getNoncesMissingCachedImage(kind, ownerAddress) {
  const db = await getDatabase();
  return db.getAllAsync(
    `SELECT nonce, image FROM ${kind}
     WHERE owner_address = ? AND status = 'ok' AND image IS NOT NULL AND local_image_path IS NULL`,
    [ownerAddress]
  );
}

/**
 * Updates just the local_image_path column for one row - used when a
 * retry successfully caches an image for an item whose metadata had
 * already been saved successfully, so nothing else about that row needs
 * to change.
 */
export async function updateLocalImagePath(kind, nonce, localImagePath) {
  const db = await getDatabase();
  await db.runAsync(`UPDATE ${kind} SET local_image_path = ? WHERE nonce = ?`, [localImagePath, nonce]);
}

/**
 * Counts, across all three collections, of anything the automatic retry
 * timer would want to work on for this wallet - broken down by WHAT kind
 * of retry it needs, not just a single total:
 *   - failedCount: 'failed' rows - these need a full NFT re-fetch
 *     (metadata + image), since the metadata itself never came through.
 *   - missingImageCount: 'ok' rows that are missing a cached image -
 *     these only need the image retried, not the metadata.
 * App.js uses this both to decide whether it's worth running a retry
 * round at all, and to describe what that round is about to do (an "NFT
 * refetch" vs an "image refetch") in the progress banner.
 */
export async function countPendingRetries(ownerAddresses) {
  const db = await getDatabase();
  const { clause, params } = ownerAddressClause(ownerAddresses);
  let failedCount = 0;
  let missingImageCount = 0;

  for (const kind of Object.keys(TRAIT_COLUMNS)) {
    const failedRow = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM ${kind} WHERE ${clause} AND status = 'failed'`,
      params
    );
    failedCount += failedRow?.count ?? 0;

    const missingImageRow = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM ${kind}
       WHERE ${clause} AND status = 'ok' AND image IS NOT NULL AND local_image_path IS NULL`,
      params
    );
    missingImageCount += missingImageRow?.count ?? 0;
  }

  return {
    failedCount,
    missingImageCount,
    total: failedCount + missingImageCount,
  };
}
