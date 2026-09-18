# ARCHITECTURE.md — a plain-English tour of the code

This walks through every file in `app/src/`, in the order you'd want to
read them if you were trying to understand the app for the first time:
data model first, then how data gets fetched, then how it's shown.

If a term here is unfamiliar (SQLite, component, hook...) it's explained
inline the first time it comes up — you shouldn't need outside references.

## The big picture

```
   [You paste a wallet address and tap Fetch]
                    |
                    v
   kleverApi.js  --> asks Klever's blockchain API: "which NFT numbers
                      (nonces) does this wallet hold, per collection?"
                    |
                    v
   metadataApi.js --> for each nonce, asks a separate metadata API:
                      "what are this NFT's name/image/stats?"
                    |
                    v
   fetchAllForWallet.js --> the conductor: runs the above two for all
                      three collections, a few at a time, reports
                      progress, and can be told to stop early
                    |
                    v
   database.js    --> saves each result into a local SQLite database
                      file on your phone (a lightweight database that
                      lives in a single file, no server needed)
                    |
                    v
   App.js + components/*  --> read from that database and display it
                      as three tabs with filters
```

## `src/constants/schema.js` — the single source of truth for "what columns exist"

This file is the one place that says, for each collection, which trait
names map to which database columns, and whether that column holds text
(like a rarity name) or a number (like an attack stat).

Why this matters: instead of the code having "which traits exist" spread
across five different files, everything else in the app (the database
setup, the save logic, the filter dropdowns) reads from this one file. If
the game ever adds a new trait we want a real column for, this is the only
file that needs a new line added.

It also solves a real quirk we found: weapons call one of their traits
`"ImprovementLevel"` (no space) while equipment calls the same concept
`"Improvement Level"` (with a space). This file maps both spellings to one
shared `improvement_level` column, so the app treats them as the same
thing rather than as two unrelated traits.

## `src/db/database.js` — everything that talks to the local database

Key functions, in the order you'd use them:

- **`initDatabase()`** — runs once when the app starts. Creates the three
  NFT tables (`devikin`, `weapon`, `equipment`) if they don't already
  exist, with columns built from `schema.js`, plus a `wallets` table (see
  below) and a generic `settings` table. Also runs small one-time
  migrations for columns/tables added after the app was already in use
  on a real phone (`ensureColumn`, and the wallets-migration described
  under "Multiple wallets" below) — these are safe to run every time the
  app starts, since they no-op once already applied.
- **`getExistingStatuses(kind, nonces)`** — before re-fetching, checks
  which nonces we already have and what state they're in (see `status`
  below), so we don't waste time re-fetching NFTs we already know are
  permanently unavailable.
- **`upsertNft(kind, {...})`** — saves one NFT's data. This is where the
  "flatten traits into columns" logic lives: it looks at each
  `trait_type` in the fetched data, finds the matching column via
  `schema.js`, and writes the value there. Any trait it doesn't recognize
  gets logged (printed) rather than silently thrown away — that's your
  signal, if you're watching the Terminal during a fetch, that the game
  added something new worth adding a real column for. Either way, the
  *entire* raw response is also always saved in a `raw_json` column, so
  nothing is ever truly lost even before a column exists for it.
- **`queryNfts(kind, ownerAddresses, filters, excludeDeleted)`** — builds
  and runs the actual `SELECT` query for what to show on screen, based on
  whatever filters are currently active. `ownerAddresses` is an array
  (matched with a SQL `IN (...)`) since the app can track more than one
  wallet now — see "Multiple wallets" below. `excludeDeleted` is the
  "Deleted" switch next to the filter toggle.
- **`getDistinctColumnValues` / `getColumnRange`** — used by the filter
  panel to figure out, from the data actually in the database, what
  dropdown options or min/max ranges to offer (see FilterPanel.js below).
  Also take `ownerAddresses` as an array now, for the same reason.
- **`getWallets` / `addWallet` / `updateWalletAddress` / `deleteWallet`**
  — plain CRUD over the `wallets` table, used by `WalletManager.js`.
  `deleteWallet` only removes the wallet from this list — it does not
  touch any NFT rows already saved under that address. `wallets` also
  has an optional `alias` column (a friendly name like "Main") that
  `updateWalletAddress(id, address, alias)` writes alongside the
  address — an empty/blank alias is stored as `NULL`, not `''`.
- **`setNftDeletedState(kind, nonce, deleted, comment)`** — the one
  function behind both "Mark as Deleted" and "Restore" in `NftCard.js`
  (just called with `deleted` true or false) — writes the `deleted` flag
  and `comment` columns for one NFT.
- **`resetAllData()`** — empties the `devikin`, `weapon`, `equipment`,
  and `wallets` tables (not dropping them, just clearing every row).
  Powers the "Reset All Data" button in `WalletManager.js`; paired
  there with `deleteAllStoredImages()` in `imageStorage.js`, which
  deletes the whole downloaded-images folder the same way.
- **`countNfts(kind, ownerAddresses, excludeDeleted)`** — just a `COUNT(*)`
  version of `queryNfts` (same `ownerAddresses` array/`excludeDeleted`
  handling, no filters). Powers the "142 Devikins"-style active-item
  count shown next to "Show filters" in `CollectionView.js`.

### The `status` column, explained

Every saved NFT has a status of `ok`, `unavailable`, or `failed`:

- `ok` — fetched fine, full data present.
- `unavailable` — the metadata API cleanly said "this doesn't exist" (a
  404 error). This is treated as a permanent, trustworthy answer, so
  future fetches skip re-asking about it.
- `failed` — something temporary went wrong (a timeout, a server error)
  after using up all retry attempts. Unlike `unavailable`, these ARE
  retried on your next fetch, because the problem was probably the
  metadata API just being flaky that one time, not the NFT actually
  missing.

### Multiple wallets

The `wallets` table (`id`, `address`, `created_at`) is the source of
truth for which addresses the app fetches from and shows NFTs for -
`App.js` loads it once on startup and again after every change made in
`WalletManager.js`, and passes the plain address list down to
`CollectionView.js` as `ownerAddresses`. Every query that used to match
`owner_address = ?` now matches `owner_address IN (...)` against that
whole list instead (see `ownerAddressClause` in `database.js`, a small
shared helper every multi-wallet query function uses).

Fetching stays sequential across wallets rather than parallel - see
`fetchAllForWallets` in `fetchAllForWallet.js` below - for the same
"don't hammer an already-flaky server" reasoning that limits
per-collection fetches to `CONCURRENCY` requests at a time.

One migration detail worth knowing: before this feature existed, the app
only ever remembered a single address (in the `settings` table, under
`lastWalletAddress`). `initDatabase()` carries that address over into the
new `wallets` table automatically, exactly once, the first time the app
opens after this update - otherwise upgrading would make already-fetched
NFT data seem to disappear (it's still in the `devikin`/`weapon`/
`equipment` tables, just with nothing in `wallets` to match it against).

## `src/api/kleverApi.js` — "which NFTs does this wallet hold?"

One function: `fetchWalletNonces(walletAddress, collectionId)`. Calls
Klever's own blockchain API, page by page, and keeps going until a page
comes back with fewer items than we asked for (meaning we've hit the end).
It deliberately does **not** trust the API's own "how many pages are
there" field — during testing we found that field lies at high page sizes,
so the code checks the actual number of items returned each time instead.

## `src/api/metadataApi.js` — "what are this NFT's stats?"

One function: `fetchNftMetadata(kind, nonce)`. This is the file with the
retry logic, since the metadata API (a third-party service, not something
we control) is known to be slow and occasionally fails outright.

- Each request gets a 10-second timeout.
- If a request times out or the server errors, it's retried up to 4 times
  with increasing waits between attempts (1 second, then 2, then 4, then
  8) — this is called "exponential backoff," and it's the standard way to
  be a polite, resilient client to a flaky API without hammering it.
- If the server instead cleanly says "not found" (404), it does **not**
  retry — that's a real, permanent answer, not a fluke.
- This function never throws an error out to whoever called it; it always
  returns a plain description of what happened (`ok` / `unavailable` /
  `failed`), which is what makes it safe for one bad NFT to never crash
  the whole fetch.

## `src/api/fetchAllForWallet.js` — the conductor

The core function is `fetchAllForWallet(walletAddress, {onProgress, shouldCancel})`,
which ties the two API files together for all three collections, for ONE
wallet address:

1. For each collection, get the full list of nonces the wallet holds
   (via `kleverApi.js`).
2. Skip any nonce already marked `unavailable` from a previous run.
3. Fetch the rest, **4 at a time** (not all at once, and not one at a
   time) — a middle ground that's much faster than doing them
   sequentially, but gentle enough not to overwhelm the metadata API.
4. After every single NFT finishes (success or failure), calls the
   `onProgress` callback so the screen can update its progress bar, and
   checks `shouldCancel()` so it can stop promptly if you tap "Stop".

`fetchAllForWallets(walletAddresses, {onProgress, shouldCancel})` (note
the extra "s") is the multi-wallet wrapper around that - it loops over
every saved wallet address, sequentially, calling `fetchAllForWallet` for
each one and tagging every progress update with `walletAddress`/
`walletIndex`/`walletTotal` so the UI can show which wallet is currently
being worked on (see `ProgressBar.js`). This is the function `App.js`
actually calls when you tap "Fetch/Update".

`retryPendingItems`/`retryPendingItemsForWallets` follow the exact same
single-wallet/multi-wallet pairing, for the background auto-retry timer
in `App.js`.

## The UI files

The app deliberately does **not** use a navigation library (like React
Navigation, which many RN apps use) — for an app with just three tabs and
no back-and-forth screen stack, plain state (`useState`, a basic React
tool for "remember which thing is currently selected") is simpler to
follow than adding a whole extra library and its concepts on top. One
thing that choice doesn't give you for free, though, is Android's
system Back button/gesture knowing to close the current "screen" first
— so both `App.js` and `CollectionView.js` each register their own
`BackHandler` listener (React Native's API for the hardware/gesture
Back action) to fill in that one specific gap; see each file's own
notes below.

- **`App.js`** — the root screen. Owns the saved wallet list (loaded from
  the database, refreshed after any change made in `WalletManager.js`),
  the Fetch/Update and Wallets buttons, which tab is active, whether the
  Wallets screen is currently showing instead of the tabs, and the
  in-progress fetch's state (so it can show a progress bar and a Stop
  button). There's no wallet-address text field here any more - that's
  all handled by `WalletManager.js` now. The Wallets button now shares
  the same solid accent colour as Fetch/Update, rather than the neutral
  bordered look it originally had. Also registers a `BackHandler`
  listener that closes the Wallets screen on Android's system Back
  action whenever it's open (same as tapping its own "‹ Back to Home"
  button), and otherwise lets Android do its normal thing. Everything
  else is broken out into smaller files below.

- **`components/WalletManager.js`** — the "Wallets" screen, opened by the
  Wallets button. Plain CRUD over the `wallets` database table: paste an
  address and tap Add; Edit/Save/Cancel an existing one inline; Delete
  one (no confirmation dialog, to match the rest of the app's plain
  style - see its own file comment for why that's low-risk). Editing a
  wallet also shows a second, optional field for naming it (e.g.
  "Main", "Trading") - once saved, that name shows up on the row to the
  right of the Edit/Delete buttons, so wallets are easier to tell apart
  than by their raw address alone. The very first wallet you ever add
  (only that one - not any added afterward) triggers a one-time popup
  reminding you that the first Fetch/Update will take a few minutes,
  since nothing's cached yet (see `handleAdd`). A "Danger zone" section
  below the wallet list has a confirmation-gated "Reset All Data"
  button (`handleResetAllData`) that empties every wallet, every saved
  NFT, and every downloaded image - back to exactly a fresh install -
  mainly there as a testing convenience. Takes over the whole content
  area the same way an NFT's detail view does in `CollectionView.js`,
  with its own "‹ Back to Home" button - this app still isn't using a
  navigation library (see above), it's the same "swap what's rendered
  based on a flag" pattern throughout.

- **`components/TabBar.js`** — the three-button row (Devikins / Weapons /
  Equipment) at the top of the results. Highlights whichever one is
  currently selected. Has the same 12px side padding as App.js's
  Fetch/Update/Wallets/theme-toggle row above it, so the two rows line
  up - the padding only insets the tab buttons themselves though, not
  this bar's own background/bottom border, which still span the full
  screen width.

- **`components/ProgressBar.js`** — shown only while a fetch is running.
  Displays which collection is currently being fetched and a count like
  "12 of 47", plus the Stop button.

- **`components/CollectionView.js`** — the main content area for one tab.
  Combines the filter controls and the list of NFT cards/rows, across
  every saved wallet at once (`ownerAddresses` - see "Multiple wallets"
  above). Handles three different "nothing to show" situations
  distinctly, so you always know *why* the list is empty:
  1. No wallet has been added yet.
  2. You fetched, and none of your wallets hold anything in this
     collection (not an error — some wallets just don't have any
     equipment, for example).
  3. There are NFTs in this collection, but your current filters (which
     now includes the Deleted switch, see below) exclude all of them.

  It also owns the list/detail switch, driven by the
  `SUMMARY_ROW_COMPONENTS` lookup at the top of the file - every
  collection (Devikins, Weapons, Equipment) now has an entry there.
  Tapping a summary row in the list sets a `selectedNonce`, which swaps
  the whole view to that item's full `NftCard` instead, with a centred
  "‹ Back to Home" link to return. This resets back to the list automatically if you
  switch tabs or fetch a different wallet. A `BackHandler` listener
  makes Android's system Back action do the same thing as that link
  whenever a detail view is open (`isDetailViewOpen`), and otherwise
  lets Android do its normal thing - see the file comment above "The UI
  files" for why this exists at all. Adding this treatment to any
  future new collection just means writing its own `<Kind>SummaryRow.js`
  (following `DevikinSummaryRow.js`, `WeaponSummaryRow.js`, or
  `EquipmentSummaryRow.js` as a template) and adding one line to
  `SUMMARY_ROW_COMPONENTS`.

  This file also owns *all* of the filtering state now - which options
  are available (asked from the database, same data-driven approach
  described under FilterPanel.js below), what's picked but not yet
  applied (`pendingFilters`), and what's actually been applied
  (`appliedFilters`). It renders the "Show filters"/"Hide filters"
  toggle and the filter buttons itself, as a plain sibling directly
  above the results `FlatList` - never inside it - so that bar is
  genuinely pinned in place and can never be scrolled out of view, no
  matter how many filter rows there are or how far down the list you
  scroll.

  The toggle row itself is a two-sided row: "Show filters"/"Hide
  filters" on the left, and on the right, always visible, the
  **Deleted** switch (off by default - see "Marking NFTs as deleted"
  below) plus, only once `hasAppliedFilters` is true, a small "Remove
  filters ✕" link - so an active filter selection can be cleared in one
  tap without expanding the panel at all. Between those two sides sits a
  small active-item count (e.g. "142 Devikins"), backed by `countNfts`
  in `database.js` - it always counts with deleted items excluded,
  independent of both the Deleted switch and any applied filters, since
  it's meant to answer "how many active items exist here" rather than
  "how many rows currently match". Below that row, "Apply
  Filters" only appears while the panel is expanded *and* there's a
  new, not-yet-applied pick waiting (`hasPendingChanges`) - there's
  nothing to show otherwise. Tapping either button re-queries the list
  *and* collapses the filter rows panel closed again, so picking or
  clearing a filter tidies the screen back up rather than leaving a
  long list of rows open. The Deleted switch itself re-queries
  immediately on toggle (it isn't part of the pending/applied two-step
  dance the trait filters use) since there's no "controls" to fiddle
  with first - it's a single on/off choice.

- **`components/FilterPanel.js`** — just the dropdowns and range boxes
  themselves (no toggle, no Apply/Remove button - those live in
  `CollectionView.js`, see above). `CollectionView.js` places this
  component inside its `FlatList`'s `ListHeaderComponent`, and only
  while the panel is expanded, so these rows scroll together with the
  results underneath them (this is also what fixes an earlier bug where
  a long list of expanded filters — 20+ for Devikins — could grow taller
  than the screen with nothing below it reachable by scrolling).

  The available options are still data-driven rather than hardcoded:
  `CollectionView.js` asks the database (via `getDistinctColumnValues`/
  `getColumnRange`) what values and ranges actually exist *for this
  specific wallet's data* and passes the result down as a prop — so if
  your wallet's NFTs only ever have 3 of the 8 possible rarities, you'll
  only see those 3 as filter options, not a bunch of dead options that
  would always return nothing.

  One deliberate detail: the numeric range boxes intentionally use the
  regular keyboard, not the phone's "numeric" keypad. iOS's numeric
  keypad has no minus-sign key, and two real traits here (Speed Modifier,
  Accuracy) can be negative — so a numeric-only keypad would make it
  impossible to type "-5" as a filter bound.

- **`components/DevikinSummaryRow.js`** — the compact, tappable row shown
  for each Devikin in the Devikins tab's list: the picture, its ID
  (`#<nonce>`, always shown), then Rarity/Ancestry/Personality, stacked.
  Tapping it is what opens the full detail view (see CollectionView.js
  above). Greyed out (`opacity: 0.45`) with a small "Deleted" tag when
  `nft.deleted` is set - still tappable, so you can open it and hit
  Restore.

- **`components/WeaponSummaryRow.js`** — the same idea for the Weapons
  tab: picture on the left, its ID then Rarity/Type/Quality stacked on
  the right. Tapping it opens that weapon's full `NftCard` detail view.
  Same greyed-out/"Deleted" tag treatment as DevikinSummaryRow.js above.

- **`components/EquipmentSummaryRow.js`** — the same idea again for the
  Equipment tab: picture on the left, its ID then Rarity/Type/Quality
  stacked on the right (a first-pass field choice, expected to be
  revisited). Tapping it opens that item's full `NftCard` detail view.
  Same greyed-out/"Deleted" tag treatment as the other two summary rows.

- **`components/NftCard.js`** — one NFT's full detail view: its image (or
  a placeholder if the image is missing or the NFT's status isn't `ok`),
  its name, its nonce number, a status badge (only shown when the status
  *isn't* `ok`, since that's the unusual case), and its trait values. All
  three collections are now only reachable by tapping their own summary
  row (see above), and each gets its own hand-arranged layout, described
  in full in NOTES.md:
  - Devikins: ID/Procreations Left/Life Stage/Overall Affinity, then
    Rarity/Ancestry/Personality, then the five gene traits, then the
    five Affinity/Attribute pairs, then anything left over.
  - Weapons: Name/nonce, then Rarity/Type/Quality, then
    Shiny/Slot/Element/Resistance Type/Gene Sync as chips, then the five
    combat stats two-per-row, then Base Durability/Durability/Improvement
    Level, then anything left over.
  - Equipment: Name/nonce, then Rarity/Type/Quality, then
    Shiny/Slot/Resistance Type as chips, then Protection/Evasion/
    Guard/Resistance two-per-row, then Accuracy/Improvement Level/
    Refine XP, then anything left over. A first pass - the user has said
    they'll want to revisit the exact field choices here.
  A generic image-left/chips-below layout still exists as a fallback in
  the code for any future new collection that hasn't gotten a custom
  layout yet, but nothing currently uses it.

  Every one of these layouts ends the same way now: a **Notes** box (a
  free-text comment, saved to the `comment` column) and a **Mark as
  Deleted** button (flips the `deleted` column and closes the loop by
  calling `onNftUpdated` - a callback `CollectionView.js` passes in as
  `reloadRows`, so the list picks up the change immediately). Once
  deleted, that same button becomes **Restore**. This is a soft,
  reversible, purely-local flag - see NOTES.md's "Marking NFTs as
  deleted" section for the full reasoning.

## Where the traits actually came from

The exact list of every trait we found per collection, with min/max
ranges for numbers and all the possible values for categories, is saved
as a doc in the claude.ai project for this app (`devikins-trait-survey.md`),
not duplicated here — `schema.js` is the code's reflection of that
research, so if you want the full original findings, that's where to look.
