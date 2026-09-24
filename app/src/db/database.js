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
 *
 * Wallet sets (added later - see the "Wallet sets" section near the
 * bottom of this file): everything above this point - the devikin/
 * weapon/equipment/settings/wallets tables, and every query function
 * that touches them - belongs to whichever ONE wallet set is currently
 * active, not the app as a whole. Each named set Raphael creates (e.g.
 * "My Wallets", "Kiddo's account", "Friend's collection") is its own
 * completely separate database FILE, so switching sets is just a matter
 * of closing this connection and opening a different file - every
 * function below keeps working completely unchanged, they just end up
 * reading/writing whichever file is currently open. A small second
 * database (see getRegistryDatabase) - never closed, never swapped -
 * keeps track of which sets exist and which one is active right now.
 */

import * as SQLite from 'expo-sqlite';
import { TRAIT_COLUMNS, RARITY_ORDER } from '../constants/schema';
import { setActiveImagesDirName, deleteStoredImagesForDir } from '../api/imageStorage';

// Which wallet set's own database FILE is currently active - see the
// "Wallet sets" section near the bottom of this file. Starts out
// pointing at the original single-set filename this app always used
// before wallet sets existed, so a fresh app start behaves exactly like
// before until initWalletSets() (called once from App.js's startup
// effect) has had a chance to check the registry and possibly point
// this somewhere else. null means no set is currently active at all
// (the "Empty" action was used) - getDatabase() is never called in that
// state (App.js doesn't query for NFTs/wallets without an active set),
// but see closeActiveDatabase below for how the actual swap happens.
let activeDatabaseFileName = 'devikins.db';

// We only want to open the database once and reuse the same connection
// everywhere, rather than re-opening it every time some part of the app
// wants to read or write. This variable caches that one open connection
// - for whichever file activeDatabaseFileName currently names.
let databaseConnectionPromise = null;

function getDatabase() {
  if (!databaseConnectionPromise) {
    databaseConnectionPromise = SQLite.openDatabaseAsync(activeDatabaseFileName);
  }
  return databaseConnectionPromise;
}

// Closes whatever per-set database connection is currently open (if
// any) and forgets it, so the next getDatabase() call opens a fresh
// connection against whatever activeDatabaseFileName has just been
// pointed at. Used by every wallet-set switch below (create/switch/
// unload/delete) - always call this BEFORE changing
// activeDatabaseFileName, never after, so nothing in between can read
// through a connection to a file that's about to stop being "the"
// active one.
async function closeActiveDatabase() {
  if (databaseConnectionPromise) {
    const db = await databaseConnectionPromise;
    await db.closeAsync();
    databaseConnectionPromise = null;
  }
}

// A second, completely separate database - never closed, never
// swapped, always the same physical file - that just keeps track of
// which wallet sets exist and which one is active. Deliberately its own
// database rather than a table inside the per-set one above: the
// per-set database is exactly the thing that gets closed and swapped
// out when you switch sets, so the registry of "what sets even exist"
// has to live somewhere that isn't affected by that swap.
const REGISTRY_DATABASE_FILE_NAME = 'wallet-sets-registry.db';
let registryConnectionPromise = null;

function getRegistryDatabase() {
  if (!registryConnectionPromise) {
    registryConnectionPromise = SQLite.openDatabaseAsync(REGISTRY_DATABASE_FILE_NAME);
  }
  return registryConnectionPromise;
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

    // The image host's ETag (a content fingerprint) for whatever's
    // currently saved at local_image_path, captured at download time.
    // Lets a periodic check ask "did Moonlabs change this picture?"
    // with a cheap HTTP HEAD request (see imageStorage.js's
    // fetchImageEtag) instead of re-downloading every image just to
    // compare it - see NOTES.md's "Automatic background retry" entries
    // for the full reasoning. NULL for anything downloaded before this
    // column existed; the freshness check backfills it the first time
    // it looks at an older row rather than assuming a change.
    await ensureColumn(db, kind, 'image_etag', 'TEXT');

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

    // V2: an optional custom nickname the user can give this specific
    // NFT - separate from `name` above, which is the in-game name pulled
    // straight from the fetched metadata and never edited by hand - plus
    // an optional 1-5 star rating. Both are set from the "Name & Rating"
    // section of the NFT detail view (see NftCard.js) and can be
    // searched/filtered from the top search bar (see App.js and
    // queryNfts's searchText/starRating parameters below). NULL means
    // "not set" for both - a custom name that's never been given, or an
    // NFT that's never been rated.
    await ensureColumn(db, kind, 'custom_name', 'TEXT');
    await ensureColumn(db, kind, 'star_rating', 'INTEGER');

    // V3: when this app FIRST ever saw this specific NFT - set once, at
    // insert time, and never touched again afterward (see upsertNft's
    // finalFirstSeen) - deliberately different from fetched_at, which
    // updates on every single re-fetch and so can't answer "how long
    // have I actually had this" or "what did I add most recently."
    // Existing rows (from before this column existed) get first_seen
    // backfilled to their current fetched_at just below, right after
    // ensureColumn adds the column - not a perfect answer for data that
    // predates this feature (fetched_at is the last check, not the
    // true first one), but a reasonable one, and it means every row
    // has a usable value immediately rather than some having none.
    await ensureColumn(db, kind, 'first_seen', 'INTEGER');
    await db.execAsync(`UPDATE ${kind} SET first_seen = fetched_at WHERE first_seen IS NULL`);
  }

  // V3: a plain append-only log of trait changes - "this NFT's rarity
  // was Common, is now Uncommon, as of this moment" - one row per
  // changed field per fetch that actually found a change, across all
  // three collections (the `kind` column tells them apart, same as the
  // per-kind tables above). Deliberately generic/shared across every
  // trait rather than needing a new column added here every time a new
  // trait is added to schema.js - see upsertNft for what actually
  // writes to this, and its own comment for exactly which changes do
  // and don't get logged. Nothing reads from this yet - the actual
  // history/timeline UI is a separate, later piece of work - so this is
  // purely "start capturing the data now, so it exists whenever that UI
  // gets built" rather than something the app currently shows anywhere.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS nft_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      nonce INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at INTEGER NOT NULL
    );
  `);
  // Every future read of this table is "everything for one NFT" (once
  // the timeline UI exists) - this index makes that a fast lookup
  // instead of a full table scan, which matters once this has been
  // running for a long time across a lot of NFTs.
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_nft_history_kind_nonce ON nft_history(kind, nonce);
  `);

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
  // Wallet sets exist now (see the "Wallet sets" section near the
  // bottom of this file) - "reset EVERYTHING" has to mean every set,
  // not just whichever one happens to be active right now, otherwise a
  // Reset would silently leave every OTHER set's database file and
  // image folder sitting on the phone untouched while claiming to have
  // wiped "every saved wallet and every stored NFT" (see WalletManager.
  // js's own confirmation text, which really does mean all of it).
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  const allSets = await registryDb.getAllAsync(`SELECT id FROM wallet_sets`);

  // Whichever set is currently active almost certainly has its database
  // file open right now - deleteDatabaseAsync on an open file can fail
  // (or silently do nothing) rather than actually removing it, and
  // since the freshly-recreated default set below reuses that exact
  // same filename, a failed delete here would mean the "reset" set
  // isn't actually empty. Close it first, same as every other
  // set-switching function in this section already does before
  // touching files.
  await closeActiveDatabase();

  for (const set of allSets) {
    await deleteWalletSetFiles(set.id);
  }
  await registryDb.runAsync(`DELETE FROM wallet_sets`);
  activeDatabaseFileName = null;
  setActiveImagesDirName(null);

  // Recreate the single starting set, exactly what a brand-new install
  // gets from initWalletSets' own first-run migration below - Reset All
  // Data should leave the app in that same "just installed" state, not
  // in the newer, arguably more confusing "no set active at all" state.
  await insertDefaultWalletSet(registryDb);
  const freshRow = await registryDb.getFirstAsync(`SELECT * FROM wallet_sets WHERE is_active = 1`);
  activeDatabaseFileName = freshRow.db_file_name;
  setActiveImagesDirName(freshRow.images_dir_name);
  await initDatabase();
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
export async function upsertNft(kind, { nonce, ownerAddress, status, metadata, localImagePath = null, imageEtag = null }) {
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

  // V2 BUG FIX, scoped carefully: INSERT OR REPLACE below only sets the
  // columns explicitly listed in allColumnNames - for `nonce`'s PRIMARY
  // KEY conflict, SQLite deletes the old row first and inserts a brand
  // new one, so any column NOT listed silently resets to its default
  // (NULL, for both of these) rather than keeping its previous value.
  // `custom_name` and `star_rating` are purely local, user-entered data
  // that never comes from the metadata API at all - there's no reason a
  // nickname or star rating should ever be wiped just because the item
  // was successfully re-fetched, so this reads their current values
  // first and carries them forward. `local_image_path`/`image_etag` get
  // their own, similar-but-not-identical preservation just below (see
  // finalLocalImagePath/finalImageEtag) - similar in that a re-fetch
  // shouldn't blindly wipe a good already-downloaded picture, but not
  // identical, because unlike a nickname, a fresh value for these two
  // SHOULD win when this call actually has one (a real image change).
  //
  // IMPORTANT: `deleted` and `comment` deliberately do NOT get the same
  // treatment - see "Marking NFTs as deleted" in NOTES.md, which
  // explains in detail why letting a successful re-fetch reset those two
  // is the CORRECT, intentional behavior (a successful re-fetch is proof
  // you still hold the NFT, so it was never actually sold/given away)
  // and says explicitly not to "fix" it. Do not add deleted/comment to
  // the preserved columns below without re-reading that note first.
  const traitColumnNames = Object.keys(traitColumns);
  const existingUserData = await db.getFirstAsync(
    `SELECT custom_name, star_rating, local_image_path, image_etag, first_seen, ${traitColumnNames.join(', ')} FROM ${kind} WHERE nonce = ?`,
    [nonce]
  );
  const preservedCustomName = existingUserData?.custom_name ?? null;
  const preservedStarRating = existingUserData?.star_rating ?? null;

  // V3: the very first time this nonce is ever seen, existingUserData is
  // null (there's no previous row at all) - that's the one and only
  // moment first_seen gets set, to right now. Every later call, whether
  // it changes anything else or not, just carries the original value
  // forward untouched - same "preserve, don't recompute" pattern as
  // preservedCustomName/preservedStarRating above.
  const finalFirstSeen = existingUserData?.first_seen ?? Date.now();

  // Same idea as custom_name/star_rating above, extended to the locally-
  // downloaded image: if THIS call didn't produce a fresh local path (or
  // a fresh ETag for it), keep whatever was already stored instead of
  // wiping it to null. Before this existed, a metadata response that
  // happened to come back without an image field, or an image download
  // that failed for an item whose file extension changed since last
  // time, could silently disconnect a perfectly good already-downloaded
  // picture from its database row - see NOTES.md's V3 notes for the
  // full explanation. Each of the two is preserved independently, since
  // a successful re-fetch can produce a path without a fresh ETag (the
  // fast-path reuse in imageStorage.js's storeImage doesn't re-check the
  // remote host at all) - in that case the path is "fresh" but the ETag
  // genuinely hasn't changed, so keeping the old ETag is correct too.
  const finalLocalImagePath = localImagePath || existingUserData?.local_image_path || null;
  const finalImageEtag = imageEtag || existingUserData?.image_etag || null;

  const allColumnNames = [
    'nonce', 'owner_address', 'name', 'image', 'local_image_path', 'image_etag', 'description', 'status', 'fetched_at', 'raw_json',
    'custom_name', 'star_rating', 'first_seen',
    ...traitColumnNames,
  ];
  const placeholders = allColumnNames.map(() => '?').join(', ');

  const params = [
    nonce,
    ownerAddress,
    name,
    image,
    finalLocalImagePath,
    finalImageEtag,
    description,
    status,
    Date.now(),
    metadata ? JSON.stringify(metadata) : null,
    preservedCustomName,
    preservedStarRating,
    finalFirstSeen,
    ...traitColumnNames.map((columnName) => traitValues[columnName]),
  ];

  // INSERT OR REPLACE: since `nonce` is the table's PRIMARY KEY, this
  // either creates a brand-new row, or completely overwrites the existing
  // row for that nonce with fresh data. That's exactly what we want for
  // re-fetching - since NFT stats can change over time (see NOTES.md),
  // the newest fetch should always win. `deleted`/`comment` are NOT
  // listed here on purpose (see the comment above) - leaving them out is
  // what resets them to their defaults, which is the intended behavior.
  await db.runAsync(
    `INSERT OR REPLACE INTO ${kind} (${allColumnNames.join(', ')}) VALUES (${placeholders})`,
    params
  );

  // V3: log any real trait change into nft_history (see initDatabase's
  // own comment on that table) - deliberately conservative about what
  // counts as "real" here, since the metadata API is already known to
  // be flaky (see NOTES.md), and this table has no way to later tell a
  // genuine in-game change apart from a fetch that happened to come
  // back incomplete:
  //   - Only ever runs for a successful fetch that actually returned
  //     metadata (status 'ok') - a failed/skipped fetch obviously has
  //     nothing new to compare.
  //   - Only ever runs when there WAS a previous row (existingUserData
  //     isn't null) - the very first time an NFT is ever fetched isn't
  //     a "change" from anything, it's just the starting point.
  //   - Only logs traits FilterPanel.js/getSortableFieldNames would
  //     also treat as real (filterable !== false) - icon_image and any
  //     future non-trait bookkeeping field stay out.
  //   - Only logs when the NEW value is an actual, present value - if
  //     a trait that had a real value last time comes back null/missing
  //     this time, that's far more likely the metadata Lambda dropping
  //     a field it shouldn't have (already a known failure mode - see
  //     the trait_type warning further up this file) than an item
  //     actually losing a trait in-game, so that's deliberately NOT
  //     logged as a change - logging it would make this table's data
  //     untrustworthy the moment the first flaky response came through.
  if (status === 'ok' && metadata && existingUserData) {
    const changedAt = Date.now();
    for (const columnName of traitColumnNames) {
      if (traitColumns[columnName].filterable === false) continue;
      const oldValue = existingUserData[columnName];
      const newValue = traitValues[columnName];
      if (newValue === null || newValue === undefined) continue;
      // Loose equality on purpose: an integer column can come back from
      // SQLite as a JS number while the freshly-parsed JSON value is
      // (depending on how the metadata API happened to send it) a
      // number or a numeric string - `==` treats 5 and "5" as equal,
      // so a same-value fetch doesn't get logged as a "change" just
      // because of a type mismatch that isn't a real difference.
      if (oldValue == newValue) continue;
      await db.runAsync(
        `INSERT INTO nft_history (kind, nonce, field_name, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [kind, nonce, columnName, oldValue === null || oldValue === undefined ? null : String(oldValue), String(newValue), changedAt]
      );
    }
  }
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
 *
 * V2 additions, both optional and independent of `filters` above:
 *   - `searchText`: the top search bar in App.js. Matches against the
 *     NFT's in-game `name`, the user's own `custom_name` (see
 *     setNftCustomName above), OR its nonce (as text, so searching "12"
 *     finds #12, #123, #1298, etc.) - whichever hits, case-insensitively.
 *     Empty/whitespace-only means "no search filter".
 *   - `starRating`: the 1-5 star picker in App.js's top bar. This is an
 *     EXACT match ("show me only my 4-star items"), not "4 stars or
 *     better" - per how it was designed. 0/null/undefined means "no
 *     rating filter".
 */
export async function queryNfts(kind, ownerAddresses, filters = {}, excludeDeleted = false, searchText = '', starRating = null, sortField = 'nonce', sortDirection = 'asc') {
  const db = await getDatabase();
  const traitColumns = TRAIT_COLUMNS[kind];

  const { clause, params: ownerParams } = ownerAddressClause(ownerAddresses);
  const whereClauses = [clause];
  const params = [...ownerParams];

  if (excludeDeleted) {
    whereClauses.push(`(deleted IS NULL OR deleted = 0)`);
  }

  const trimmedSearch = typeof searchText === 'string' ? searchText.trim() : '';
  if (trimmedSearch.length > 0) {
    whereClauses.push(
      `(LOWER(name) LIKE ? OR LOWER(custom_name) LIKE ? OR CAST(nonce AS TEXT) LIKE ?)`
    );
    const likePattern = `%${trimmedSearch.toLowerCase()}%`;
    params.push(likePattern, likePattern, likePattern);
  }

  if (starRating) {
    whereClauses.push(`star_rating = ?`);
    params.push(Number(starRating));
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

  // ORDER BY nonce ASC here is deliberately unconditional, regardless of
  // what sortField/sortDirection actually asked for - it's what gives
  // every sort below its "ID ascending" tiebreaker automatically. Array
  // sorting in JS is guaranteed stable (equal elements keep their
  // original relative order), so starting from a nonce-ordered array
  // and then sorting by whatever the user actually picked means ties on
  // that field naturally fall back to plain ID order, without writing
  // any separate tiebreak logic - see buildSortComparator below.
  const sql = `SELECT * FROM ${kind} WHERE ${whereClauses.join(' AND ')} ORDER BY nonce ASC`;
  const rows = await db.getAllAsync(sql, params);

  if (sortField === 'nonce' && sortDirection === 'asc') {
    // Already exactly the order the query above produced - nothing left
    // to do (this is also today's original, pre-sorting-feature
    // behavior, unchanged for anyone who's never touched Sort).
    return rows;
  }

  return [...rows].sort(buildSortComparator(sortField, sortDirection, traitColumns));
}

// Compares two rows for queryNfts' sort - `sortField` is either 'nonce'/
// 'first_seen' (plain numbers, not part of TRAIT_COLUMNS) or one of this
// kind's actual trait columns. `rarity` gets its own special case since
// "Common < Uncommon < Rare < ..." isn't alphabetical order (see
// RARITY_ORDER's own comment in schema.js) - every other text trait
// just sorts alphabetically, and every integer trait numerically.
function buildSortComparator(sortField, sortDirection, traitColumns) {
  const columnKind = traitColumns[sortField]?.kind ?? 'integer'; // nonce/first_seen are both INTEGER columns
  const directionMultiplier = sortDirection === 'desc' ? -1 : 1;

  return (rowA, rowB) => {
    const valueA = rowA[sortField];
    const valueB = rowB[sortField];
    const missingA = valueA === null || valueA === undefined;
    const missingB = valueB === null || valueB === undefined;

    // An NFT that simply doesn't have this trait isn't meaningfully
    // "highest" or "lowest" - it's just not comparable, so it always
    // sorts to the very end, regardless of ascending/descending (i.e.
    // NOT affected by directionMultiplier below - flipping the sort
    // direction shouldn't move missing values to the front).
    if (missingA && missingB) return 0;
    if (missingA) return 1;
    if (missingB) return -1;

    let comparison;
    if (sortField === 'rarity') {
      comparison = RARITY_ORDER.indexOf(valueA) - RARITY_ORDER.indexOf(valueB);
    } else if (columnKind === 'text') {
      comparison = String(valueA).localeCompare(String(valueB));
    } else {
      comparison = Number(valueA) - Number(valueB);
    }
    return comparison * directionMultiplier;
  };
}

/**
 * Powers the Breeding Helper screen (see BreedingHelper.js) - returns
 * every OTHER Devikin from the given wallets that's actually worth
 * considering as a breeding partner for the Devikin identified by
 * `excludeNonce`.
 *
 * "Worth considering" here isn't a scored ranking - it's a hard filter,
 * built directly from Raphael's own breeding experience (there is no
 * official rule book for pairing strategy - see BreedingHelper.js's own
 * file comment for the full research trail). He's bred roughly 2,000
 * Devikins and the two rules that matter most are: always breed the
 * exact same Rarity, and always breed the exact same Procreations
 * Left - anything else is "a waste" (his words).
 *
 * Rarity is a hard, non-negotiable exact match - there's no tolerance
 * for it, ever. Procreations Left defaults to an exact match too, but
 * `procreationsTolerance` (0 by default) can widen that to a +/-N
 * range - see Breeding Helper's "Allow +/-1" toggle. This is a real,
 * sometimes-necessary exception per Raphael himself, not a mistake: a
 * mismatched pair still breeds fine in-game, it's just priced (and its
 * offspring's own Procreations Left is set) off whichever of the two
 * parents has FEWER Procreations Left, not the higher one - e.g.
 * pairing a 10-left with a 6-left charges the 6-left price and produces
 * a 5-left offspring. BreedingHelper.js is responsible for surfacing
 * that consequence per-candidate once a mismatched result comes back
 * from here - this function only decides which candidates are eligible
 * to show at all.
 *
 * Also excluded unconditionally, regardless of rarity/procreations:
 *   - the selected Devikin itself (excludeNonce)
 *   - anything with 0 Procreations Left - it's done breeding
 *   - Eldritch Devikins - the game keeps them rare on purpose by not
 *     letting them procreate at all (this rules out `rarity` itself
 *     ever being 'Eldritch', for both the selected Devikin and every
 *     candidate)
 *   - anything marked Deleted (see setNftDeletedState) - no longer
 *     part of the collection the user actually cares about
 *   - anything whose metadata never successfully fetched (status !=
 *     'ok') - there's no real Rarity/Procreations Left to check
 *
 * What this CANNOT do, and never claims to: check whether two Devikins
 * are actually related (parent, sibling, offspring). No lineage/parent
 * data exists anywhere in this app's metadata source (confirmed against
 * every known trait in schema.js) - avoiding related pairs is still
 * entirely on the user, exactly as it is in the game itself today.
 */
export async function getBreedingCandidates(ownerAddresses, { rarity, procreationsLeft, excludeNonce, procreationsTolerance = 0 }) {
  const db = await getDatabase();
  const { clause, params: ownerParams } = ownerAddressClause(ownerAddresses);
  // Math.max(1, ...) on the lower bound rather than letting it go to 0
  // or negative - a 0-or-below Procreations Left is already excluded by
  // the "procreations_left > 0" clause below regardless, but clamping
  // here keeps the BETWEEN bounds themselves sensible even when
  // procreationsTolerance is large. tolerance=0 collapses this to a
  // plain exact match (min === max === procreationsLeft), so the same
  // query handles both the default and the widened case.
  const minProcreations = Math.max(1, procreationsLeft - procreationsTolerance);
  const maxProcreations = procreationsLeft + procreationsTolerance;
  const rows = await db.getAllAsync(
    `SELECT * FROM devikin
     WHERE ${clause}
       AND status = 'ok'
       AND (deleted IS NULL OR deleted = 0)
       AND rarity = ?
       AND rarity != 'Eldritch'
       AND procreations_left BETWEEN ? AND ?
       AND procreations_left > 0
       AND nonce != ?
     ORDER BY nonce ASC`,
    [...ownerParams, rarity, minProcreations, maxProcreations, excludeNonce]
  );
  return rows;
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
 * Saves (or clears, if customName is empty/null) the user's own nickname
 * for one specific NFT - see the "custom_name" column comment in
 * initDatabase above, and the Name & Rating section in NftCard.js that
 * calls this. Separate from setNftStarRating below so the two fields can
 * be saved independently (e.g. tapping a star shouldn't require first
 * typing a name).
 */
export async function setNftCustomName(kind, nonce, customName) {
  const db = await getDatabase();
  const trimmed = typeof customName === 'string' ? customName.trim() : '';
  await db.runAsync(
    `UPDATE ${kind} SET custom_name = ? WHERE nonce = ?`,
    [trimmed.length > 0 ? trimmed : null, nonce]
  );
}

/**
 * Saves (or clears, if starRating is null/0) the user's own 1-5 star
 * rating for one specific NFT - see the "star_rating" column comment in
 * initDatabase above. Tapping an already-selected star in NftCard.js
 * clears the rating back to "not rated" by passing null/0 here, rather
 * than there being a separate "clear rating" control.
 */
export async function setNftStarRating(kind, nonce, starRating) {
  const db = await getDatabase();
  const normalized = starRating ? Math.max(1, Math.min(5, Number(starRating))) : null;
  await db.runAsync(
    `UPDATE ${kind} SET star_rating = ? WHERE nonce = ?`,
    [normalized, nonce]
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
 * Updates the local_image_path (and, now, image_etag) columns for one
 * row - used when a retry successfully caches an image for an item
 * whose metadata had already been saved successfully, so nothing else
 * about that row needs to change. `imageEtag` is optional and defaults
 * to null (unknown) rather than being required, since not every caller
 * has one on hand.
 */
export async function updateLocalImagePath(kind, nonce, localImagePath, imageEtag = null) {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE ${kind} SET local_image_path = ?, image_etag = ? WHERE nonce = ?`,
    [localImagePath, imageEtag, nonce]
  );
}

/**
 * Rows with a cached local image already saved - the candidates for the
 * periodic "did Moonlabs change this picture?" freshness check (see
 * fetchAllForWallet.js's checkImageFreshnessForWallets and
 * imageStorage.js's fetchImageEtag). Includes image_etag (may be null,
 * for anything downloaded before that column existed) and
 * local_image_path itself, since the freshness check needs to pass the
 * existing path back in when it's only backfilling an ETag rather than
 * forcing a real re-download.
 */
export async function getCachedImageRows(kind, ownerAddress) {
  const db = await getDatabase();
  return db.getAllAsync(
    `SELECT nonce, image, image_etag, local_image_path FROM ${kind}
     WHERE owner_address = ? AND status = 'ok' AND image IS NOT NULL AND local_image_path IS NOT NULL`,
    [ownerAddress]
  );
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


// ===========================================================================
// Wallet sets
// ===========================================================================
//
// A "wallet set" is a completely independent copy of everything above
// this comment - its own wallets table, its own devikin/weapon/
// equipment tables, its own settings table, and its own downloaded
// images folder (see imageStorage.js) - identified by a name Raphael
// picks (e.g. "My Wallets", "Kiddo's account", "Friend's collection").
// The point: switching between them is instant and never re-fetches
// anything, because nothing is actually being merged/filtered from one
// shared pool - each set is just a different pair of files
// (database + images folder) on the phone, and "switching" is nothing
// more than closing the current database connection and opening a
// different one (see closeActiveDatabase/getDatabase above), plus
// pointing imageStorage.js at a different folder name
// (setActiveImagesDirName). Every query function ABOVE this comment
// keeps working completely unchanged either way.
//
// The registry of which sets exist - just their names and which two
// filenames belong to them - lives in its own small, always-open
// database (getRegistryDatabase above) that's never itself part of a
// swap, since it has to survive being able to describe every set,
// including ones that aren't currently open.
//
// First-run migration: initWalletSets() (called once from App.js's
// startup effect, before initDatabase()) checks whether the registry
// has any sets in it at all. The very first time this code runs on a
// phone that's already been using the app (back when there was no such
// thing as multiple sets), it hasn't - so it registers a set called
// "My Wallets" that points at the exact same filenames the app already
// used (devikins.db / nft-images), with zero data actually moved or
// copied anywhere. Every wallet, NFT, and image that already existed
// keeps working exactly as before, just now described as belonging to
// this one named set. The exact same migration-on-first-run shape
// initDatabase() already uses for the wallets table (see its own
// comment further up) - a pattern this codebase has done before.

// Shared by initWalletSets' first-run migration and resetAllData's
// "start over from nothing" recreation - both want the exact same
// starting set, just at different moments.
async function insertDefaultWalletSet(registryDb) {
  await registryDb.runAsync(
    `INSERT INTO wallet_sets (name, db_file_name, images_dir_name, created_at, is_active)
     VALUES (?, ?, ?, ?, 1)`,
    ['My Wallets', 'devikins.db', 'nft-images', Date.now()]
  );
}

// Deletes one set's own database file and image folder, by id, WITHOUT
// touching the registry row itself - shared by deleteWalletSet (which
// also removes the row afterward) and resetAllData (which wipes every
// row at once in a single DELETE, rather than one at a time). Safe to
// call on a set that was created but never actually fetched into (its
// database file may not exist as an actual file yet - deleteDatabaseAsync
// on a name that was never opened is a harmless no-op, same idea as
// deleteStoredImagesForDir already being safe on a folder that was
// never created).
async function deleteWalletSetFiles(id) {
  const registryDb = await getRegistryDatabase();
  const set = await registryDb.getFirstAsync(`SELECT * FROM wallet_sets WHERE id = ?`, [id]);
  if (!set) return;
  await SQLite.deleteDatabaseAsync(set.db_file_name).catch(() => {});
  await deleteStoredImagesForDir(set.images_dir_name);
}

// Creates the registry's two tables if they don't already exist yet -
// pulled out into its own memoized helper (rather than living inline
// inside initWalletSets below) because of a real race that showed up in
// testing: App.js's viewMode effect calls getGlobalSetting('viewMode')
// from a completely separate useEffect that isn't sequenced after
// initWalletSets() at all (both just fire independently on mount), and
// on a phone that's NEVER had this registry database before (i.e.
// everyone upgrading from v2, since this file didn't exist until wallet
// sets did), whichever one happened to query global_settings first lost
// the race and hit "no such table" - surfacing as an uncaught
// "NativeDatabase.prepareAsync has been rejected" error. Rather than
// trying to carefully order every caller relative to initWalletSets
// (fragile, and easy to break again the next time something new touches
// the registry), every exported function in this section calls this
// first - CREATE TABLE IF NOT EXISTS is cheap and idempotent, and the
// module-level promise means the actual table-creation SQL only ever
// runs once no matter how many callers race to call this at startup.
let registryTablesReadyPromise = null;

async function ensureRegistryTablesExist() {
  if (!registryTablesReadyPromise) {
    registryTablesReadyPromise = (async () => {
      const registryDb = await getRegistryDatabase();
      await registryDb.execAsync(`
        CREATE TABLE IF NOT EXISTS wallet_sets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          db_file_name TEXT NOT NULL UNIQUE,
          images_dir_name TEXT NOT NULL UNIQUE,
          created_at INTEGER,
          is_active INTEGER NOT NULL DEFAULT 0
        );
      `);
      // A tiny key/value table for app-wide preferences that should stay
      // the same no matter which wallet set is active (List/Tiles view
      // mode is the one example today - see App.js) - deliberately NOT
      // the same `settings` table initDatabase() creates per set further
      // up, since that one gets swapped out along with everything else
      // when you switch sets, and a display preference switching along
      // with it would be a surprising side effect of picking a different
      // set.
      await registryDb.execAsync(`
        CREATE TABLE IF NOT EXISTS global_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT
        );
      `);
    })();
  }
  return registryTablesReadyPromise;
}

/**
 * Runs the first-run "My Wallets" migration described above if the
 * registry is still completely empty, then points activeDatabaseFileName/
 * imageStorage.js at whichever set is currently marked active and runs
 * that set's own initDatabase() (its schema may be out of date if this
 * set hasn't been opened since an app update added a new column/table).
 *
 * Called once from App.js's startup effect, BEFORE initDatabase() -
 * App.js only goes on to call initDatabase()/loadWallets() itself if
 * this returns a real id; a null return means no set is currently
 * active (the "Empty" action was used), and App.js shows the Wallets
 * screen so Raphael can load or create one instead of trying to query
 * NFT data that has nowhere to come from right now.
 */
export async function initWalletSets() {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();

  const existingSetCount = await registryDb.getFirstAsync(`SELECT COUNT(*) AS count FROM wallet_sets`);
  if ((existingSetCount?.count ?? 0) === 0) {
    await insertDefaultWalletSet(registryDb);
  }

  const activeRow = await registryDb.getFirstAsync(`SELECT * FROM wallet_sets WHERE is_active = 1`);
  if (!activeRow) {
    // Nothing active - the "Empty" action was used on a previous run.
    // Leave activeDatabaseFileName/imageStorage.js pointing at nothing
    // rather than guessing; App.js handles this state explicitly.
    activeDatabaseFileName = null;
    setActiveImagesDirName(null);
    return null;
  }

  activeDatabaseFileName = activeRow.db_file_name;
  setActiveImagesDirName(activeRow.images_dir_name);
  await initDatabase();
  return activeRow.id;
}

/**
 * Every wallet set that exists, oldest first - powers the switcher list
 * in WalletManager.js (name, which one's currently active, when it was
 * created).
 */
export async function getWalletSets() {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  return registryDb.getAllAsync(
    `SELECT id, name, db_file_name, images_dir_name, created_at, is_active FROM wallet_sets ORDER BY id ASC`
  );
}

/**
 * Creates a brand-new, empty wallet set and immediately makes it the
 * active one - "create" and "start using it" are the same action here,
 * same as adding a wallet doesn't need a separate "save" step (see
 * Raphael's own call on this during the design discussion). The new
 * set's database/images filenames are derived from the current
 * timestamp, which is all that's needed to guarantee they don't collide
 * with any existing (or previously deleted) set's files.
 */
export async function createWalletSet(name) {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  const trimmedName = (name || '').trim() || 'New Set';
  const suffix = Date.now();
  const dbFileName = `devikins-set-${suffix}.db`;
  const imagesDirName = `nft-images-set-${suffix}`;

  await closeActiveDatabase();
  await registryDb.runAsync(`UPDATE wallet_sets SET is_active = 0`);
  const result = await registryDb.runAsync(
    `INSERT INTO wallet_sets (name, db_file_name, images_dir_name, created_at, is_active)
     VALUES (?, ?, ?, ?, 1)`,
    [trimmedName, dbFileName, imagesDirName, suffix]
  );

  activeDatabaseFileName = dbFileName;
  setActiveImagesDirName(imagesDirName);
  await initDatabase();
  return result.lastInsertRowId;
}

/**
 * Renames an existing set - the "My Wallets" default included, since
 * that name is just a starting guess about whose collection it is, not
 * a fixed label (Raphael's own call: it might not be his own wallets he
 * wants to check first).
 */
export async function renameWalletSet(id, name) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) return;
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  await registryDb.runAsync(`UPDATE wallet_sets SET name = ? WHERE id = ?`, [trimmedName, id]);
}

/**
 * Makes an existing set the active one - closes whatever set is
 * currently open, points activeDatabaseFileName/imageStorage.js at the
 * target set's own files, and runs that set's initDatabase() (in case
 * its schema hasn't been touched since an app update added a column).
 * A no-op if the requested id doesn't exist (shouldn't happen from the
 * UI, which only ever offers ids from getWalletSets' own list, but this
 * stays safe rather than leaving the app with no active set at all if
 * it somehow did).
 */
export async function switchToWalletSet(id) {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  const targetSet = await registryDb.getFirstAsync(`SELECT * FROM wallet_sets WHERE id = ?`, [id]);
  if (!targetSet) return;

  await closeActiveDatabase();
  await registryDb.runAsync(`UPDATE wallet_sets SET is_active = 0`);
  await registryDb.runAsync(`UPDATE wallet_sets SET is_active = 1 WHERE id = ?`, [id]);

  activeDatabaseFileName = targetSet.db_file_name;
  setActiveImagesDirName(targetSet.images_dir_name);
  await initDatabase();
}

/**
 * Closes out the currently active set WITHOUT deleting any of its data
 * - Raphael's own "Empty" action: leaves the app with nothing active at
 * all until Wallets is used again to load a different set or create a
 * new one. Every already-saved wallet/NFT/image for this set stays
 * exactly where it is on the phone, untouched - "Empty" only clears
 * which one is marked active, the same state a brand-new install (or a
 * Reset All Data) is already in before its own first set is created.
 */
export async function unloadCurrentWalletSet() {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  await closeActiveDatabase();
  await registryDb.runAsync(`UPDATE wallet_sets SET is_active = 0`);
  activeDatabaseFileName = null;
  setActiveImagesDirName(null);
}

/**
 * Permanently deletes one wallet set - its database file, its image
 * folder, and its row in the registry - with no way to get it back
 * (WalletManager.js gets a real confirmation prompt in front of this,
 * matching Reset All Data's own). Works on ANY set, not just the
 * currently active one, so a set that turned out to be a mistake (e.g.
 * pointed at the wrong address and pulled in a huge pile of broken
 * entries) can be removed without first having to switch into it. If
 * the set being deleted happens to be the active one, the app is left
 * with nothing active afterward, same as unloadCurrentWalletSet above -
 * Raphael goes back to Wallets to load or create a different one.
 */
export async function deleteWalletSet(id) {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  const target = await registryDb.getFirstAsync(`SELECT * FROM wallet_sets WHERE id = ?`, [id]);
  if (!target) return;

  const wasActive = !!target.is_active;
  if (wasActive) {
    await closeActiveDatabase();
  }
  await deleteWalletSetFiles(id);
  await registryDb.runAsync(`DELETE FROM wallet_sets WHERE id = ?`, [id]);

  if (wasActive) {
    activeDatabaseFileName = null;
    setActiveImagesDirName(null);
  }
}

/**
 * Reads one app-wide preference that should stay the same regardless of
 * which wallet set is active (see global_settings' own comment in
 * initWalletSets above) - List/Tiles view mode today. Returns null if
 * the key has never been set.
 */
export async function getGlobalSetting(key) {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  const row = await registryDb.getFirstAsync(`SELECT value FROM global_settings WHERE key = ?`, [key]);
  return row?.value ?? null;
}

/**
 * Saves one app-wide preference, overwriting any previous value for
 * that key. See getGlobalSetting above.
 */
export async function setGlobalSetting(key, value) {
  await ensureRegistryTablesExist();
  const registryDb = await getRegistryDatabase();
  await registryDb.runAsync(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)`, [key, value]);
}
