# Devikins Legacy Companion — Project Notes

This file is the running log of decisions made for this project. It exists so
that anyone picking this project back up later (including a future me, or a
future you) doesn't have to rediscover things the hard way. Read this before
making changes.

## What this project is

A personal app to browse the Devikins NFTs (a Klever-blockchain game) sitting
in your own wallet: three collections — characters, weapons, equipment — with
filterable stats. Not a coding background; built with heavy AI assistance,
so the code is commented more generously than usual and the docs assume no
prior React Native/Expo knowledge.

## The three collections

| Name | Klever asset ID | Metadata API "kind" |
|---|---|---|
| Devikins (characters) | `DVKNFT-1SW5` | `devikin` |
| Weapons | `DVKWPNFT-169T` | `weapon` |
| Equipment | `DVKEQNFT-1Q56` (⚠️ capital **Q**, not a zero — easy to mistype) | `equipment` |

## The two APIs we depend on

1. **Klever chain API** (`https://api.mainnet.klever.org/v1.0/`) — tells us
   which NFTs a wallet holds. The endpoint that actually works for this is
   `GET /address/{address}/collection/{collectionID}` (paginated via
   `page`/`limit`). A confusingly-documented endpoint,
   `GET /assets/{id}/{nonce}`, is listed in Klever's own Swagger docs but does
   **not** actually return per-NFT data in practice — don't use it.

2. **AWS metadata API** (`https://1fl8e08843.execute-api.us-east-1.amazonaws.com/`)
   — the only source of actual NFT traits (rarity, stats, etc). Not run by
   Klever — looks like the game studio's own Lambda. Path pattern:
   `GET /{kind}/{nonce}` (e.g. `/devikin/1`, `/weapon/100`, `/equipment/1`).
   **This API is slow and unreliable** — expect roughly a 1-in-10 chance of
   any single request timing out or erroring, even when the NFT is perfectly
   fine. Always use retry with backoff, never treat one failure as final.

Full endpoint research, exact example responses, and the complete list of
every trait we found per collection (with min/max ranges and all category
values) are saved as docs in the claude.ai project for this app — ask Claude
to re-surface them if needed (`klever-api-endpoints.md` and
`devikins-trait-survey.md`).

## Important data quirks (don't relearn these the hard way)

- **Metadata is NOT permanent/static.** Slots can be added to weapons and
  equipment later, and Devikins level up over time. A trait value you fetch
  today might be different next month for the exact same NFT. Never treat a
  cached fetch as forever-true — see the caching approach below.
- **Trait key spelling differs between collections for the same concept:**
  weapons use `"ImprovementLevel"` (no space), equipment uses
  `"Improvement Level"` (with a space). The app normalizes both into one
  `improvement_level` database column.
- **Some numeric traits go negative** — confirmed for weapons' `Speed Modifier`
  (-15 to +10 in our sample) and per the user's own game knowledge,
  `Accuracy` can too. Never assume a numeric filter's minimum is 0.
- **Not every item necessarily has every trait**, even though our ~30-per-
  collection sample happened to find every trait on every sampled item. Code
  defensively — missing fields should not crash anything.
- **Pagination is unreliable at high `limit` values.** The API's own
  `pagination.totalPages`/`perPage` fields just echo back whatever you asked
  for — they don't reflect what was actually returned. At `limit` values
  above ~300 we saw the real returned array silently truncate to 100 items
  while `pagination` claimed otherwise. The app always checks the actual
  number of items returned per page rather than trusting those fields, and
  uses `limit=100` to stay safely under the truncation point.
- **A picture can genuinely just be blank/white on-chain, with no error
  anywhere.** Confirmed on equipment #42989 ("Decent Eldritch Socks"): its
  metadata fetch succeeds normally and its `image` URL loads fine (no 404,
  no broken link) - the picture itself is just a plain white square. Per
  the user, this happens when the game studio updates an item's art
  in-game but never re-uploads the matching image to the blockchain/CDN
  side, so the two go out of sync. This is NOT something the app's
  "Unavailable" fallback is meant to catch (that's specifically for
  fetch/load *failures* - a picture that loads successfully is, as far as
  the app can tell, a real, deliberate picture) - if you spot another item
  like this, it's very likely the same situation rather than a bug here.

## The three-wallets confusion (important — read this if anything seems to be "missing")

There are three different places a Devikin/weapon/equipment NFT can sit:

1. **Your personal Klever wallet** — a normal wallet you control.
2. **A per-account "in-game" wallet** — the game creates this and you send an
   NFT there to actually use it in gameplay.
3. **The game's main contract address**
   (`klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf`) — holds
   the vast majority of the entire characters collection (~94% of it). This
   includes burned NFTs, but also plenty of non-burned ones (staking,
   escrow, marketplace listings, unclaimed mints). **Do not treat "held by
   this address" as a reliable "this NFT is burned" signal** — it isn't one.

**This app deliberately only shows NFTs in your personal wallet (#1).** The
in-game wallet and the contract address are out of scope on purpose — you
decided this after realizing that most of your collection sits in the game
wallet, and that reverse-engineering the game's own backend to show
game-wallet holdings wasn't worth it for a game that's shutting down in
about a year anyway (from Sept 2026). If you ever want to also see what's in
the game wallet, that's a separate, harder problem — it needs the game's own
authenticated API, not anything documented here.

## Clearer "unavailable" states

Two small clarity fixes, both per feedback:

- The image placeholder (shown whenever there's no cached AND no remote
  image to display) now says "Unavailable" instead of a bare "?", used
  everywhere a thumbnail can be missing (NftCard.js and
  DevikinSummaryRow.js share this).
- In the Devikins list, an item whose status isn't `ok` (so its Rarity/
  Ancestry/Personality were never actually fetched) now shows one clear
  "Details unavailable" / "Fetch failed - will retry" line instead of
  three blank-looking `Field: —` lines.

**Update:** the placeholder above only covered items with no image URL
at all - it missed items that DO have an `image` URL (or an old
`local_image_path`) recorded, but where that file no longer actually
loads, most often something fetched a while ago that never got a local
copy cached, whose original remote image host has since gone offline or
moved. Those were rendering as a blank box instead of the "Unavailable"
message, since the app only checked whether a URL was present, not
whether it actually worked. All four places that show an NFT's picture
(`NftCard.js`, `DevikinSummaryRow.js`, `WeaponSummaryRow.js`,
`EquipmentSummaryRow.js`) now also listen for the image failing to load
(`<Image>`'s `onError`) and fall back to the same "Unavailable" placeholder
in that case too - covering every item that's already in the database,
not just ones fetched from now on. If a later background retry manages
to cache a working local copy for one of these, it'll automatically get
a fresh chance to display instead of staying stuck on the placeholder.

## Devikin list/detail view

The Devikins tab now has two views, switched with plain React state (no
navigation library, same philosophy as the tab bar - see App.js's file
comment):

- **List** (`DevikinSummaryRow.js`): a compact, tappable row per Devikin -
  just the picture on the left and Rarity/Ancestry/Personality stacked on
  the right. This is what you scroll through.
- **Detail** (`NftCard.js`'s existing full devikin layout - unchanged):
  shown when you tap a row, with a "Back" link at the top to return to
  the list.

`CollectionView.js` owns which of the two is showing (`selectedNonce`
state) - it resets back to the list automatically if you switch tabs or
fetch a different wallet, so you never get stuck looking at a detail view
that no longer makes sense. Weapons and Equipment are unaffected - they
still show their full card directly in the list, since this was only
asked for Devikins.

*(Update: Weapons got the same treatment shortly after - see "Weapons
list/detail view and card layout" below. Equipment is still unaffected.)*

## Devikin card layout, redesigned per feedback

The Devikin tab's card is now a specific, hand-arranged layout rather
than the generic "chips in a column" version from earlier:

    [picture]   #1234 (ID)
                Procreations Left: 7
                Life Stage: Adult
                Overall Affinity: 34
    -------------------------------------
      Rarity      Ancestry     Personality
    -------------------------------------
    [Eyes/Mouth/Ears/Hair/Horns Gene chips]
    -------------------------------------
    Vitality Affinity    |  Vitality Attribute
    Power Affinity       |  Power Attribute
    Fortitude Affinity   |  Fortitude Attribute
    Agility Affinity     |  Agility Attribute
    Sanity Affinity      |  Sanity Attribute
    [any other stat this item has, as before]

The five Affinity/Attribute pairs are lined up on purpose - each row is
one stat (Vitality, Power, Fortitude, Agility, Sanity) with its Affinity
value on the left and its matching Attribute value on the right, since
those two numbers describe the same underlying stat at two different
scales.

The specific traits placed into each section (`topStatKeys`/
`triStatKeys`/`geneStatKeys` in NftCard.js) are named explicitly rather
than derived automatically - this particular grouping is about what
these traits MEAN (the five genes belong together; rarity/ancestry/
personality are "core identity" stats), not a pattern that would still
make sense on its own if the game added a new trait later. Anything not
explicitly placed (the affinity/attribute numbers, mainly) still shows up
in a catch-all row at the bottom, same style as before, so nothing is
hidden just because the layout above it is hand-arranged. If the game
ever adds a brand new Devikin trait, it'll automatically appear down
there rather than needing this layout edited.

Weapons and Equipment cards are unchanged.

**Update:** per feedback, the picture in the Devikin detail view's top
row is now 100% bigger than before - a 224x224 image (up from the
standard 112x112 used everywhere else in the app, including the Devikins
list rows and the Weapons/Equipment detail views). `NftCard.js` now
builds two versions of the image element (`image` and `largeImage`) from
the same underlying `imageSource` state, so the "Unavailable" fallback
and retry-on-fix behavior described above work identically for both -
only the Devikin top row uses the larger one.

The three values next to it (Procreations Left / Life Stage / Overall
Affinity) were briefly enlarged to match, then reverted back to their
original size per follow-up feedback - so the image is bigger, but that
text stays as it was.

**Update:** briefly reduced 10% from that (224x224 down to 202x202), then
undone back to 224x224 per follow-up feedback. While addressing that,
also fixed a real cropping issue: the image had no explicit `resizeMode`,
which defaults to `"cover"` - this zooms the picture in just enough to
completely fill its box, cropping whatever doesn't fit the box's own
(square) aspect ratio. Added `resizeMode="contain"` instead, so the whole
picture always fits inside the box, uncropped (any leftover space around
a non-square image just shows the card's own background instead).

**Update:** that same missing-`resizeMode` issue turned out to still be
present everywhere else a picture is shown - the small thumbnails in the
Devikins/Weapons/Equipment list rows (`DevikinSummaryRow.js`,
`WeaponSummaryRow.js`, `EquipmentSummaryRow.js`) and the Weapons/
Equipment detail view's picture (`NftCard.js`'s smaller `image`, as
opposed to the Devikin-only `largeImage` fixed above) - all of them were
still defaulting to `"cover"` and slightly cropping (most noticeably at
the bottom). Added `resizeMode="contain"` to all of them too, for the
same reason as above, so nothing shown anywhere in the app crops a
picture to fit its box any more.

## Migrated off the deprecated SafeAreaView

Expo started warning that `SafeAreaView` from the core `react-native`
package is deprecated, in favor of the community package
`react-native-safe-area-context`. Migrated App.js to it: the whole app is
now wrapped in that package's `SafeAreaProvider`, and `SafeAreaView` is
imported from `react-native-safe-area-context` instead of `react-native`.

This also let us delete the manual "add extra padding on Android because
SafeAreaView doesn't reserve space for the status bar there" workaround
from the earlier "leave space at the top" fix - the new package handles
that correctly (and more robustly - it also accounts for things like
Android's gesture-navigation bar) on its own. The separate, deliberate
extra breathing room above the address field (`inputColumn`'s
`paddingTop: 28`) is unrelated to safe-area correctness and is still
there.

Needs the `react-native-safe-area-context` package installed - see
SETUP.md.

## Renamed imageCache.js to imageStorage.js (and fixed a real bug found along the way)

The file was originally called `imageCache.js` (function `cacheImage`),
which was misleading: "cache" on a phone usually implies a folder the OS
can wipe without warning under storage pressure. This never used that
kind of folder - it always saved into Expo's persistent `documentDirectory`,
which the OS won't touch. Renamed to `imageStorage.js`/`storeImage()` to
make that clear at a glance, since it came up as a real question.

While doing the rename, found a genuine bug in the dev logs: expo-file-
system 57 (the version installed here) moved its classic promise-based
functions (`getInfoAsync`, `downloadAsync`, `makeDirectoryAsync`,
`deleteAsync`, `documentDirectory`) behind an `expo-file-system/legacy`
import path - importing plain `expo-file-system` gives you a different,
class-based API instead, and calling the old function names on it throws
a "deprecated" error rather than working. This was silently breaking
every single image download (that's why equipment's image never saved).
Fixed by importing from `expo-file-system/legacy` instead.

## Automatic retry timer (background)

While the app is open with a wallet loaded, it checks once a minute
whether that wallet has anything left unfinished - items still stuck in
`failed` status, or items that fetched fine but never got their image
cached (see the `local_image_path` note below) - and quietly retries just
those, without a full re-fetch from the blockchain. This is what recovers
from a rough patch with the flaky metadata API without you having to keep
tapping Fetch by hand.

After 10 retry rounds in a row (about 10 minutes) if the problem hasn't
cleared up, it backs off rather than hammering a service that might
genuinely be down for longer than that - but it doesn't give up for
good. **Update:** it now switches to checking just once an hour instead,
and keeps doing that indefinitely for as long as the app stays open. The
one-minute timer under the hood never actually stops; it just skips
almost all of its ticks once backed off, only acting again once an hour
has passed. Tapping Fetch manually always resets straight back to the
fast once-a-minute pace, whether or not it had backed off. This was
added because some items seem to only become fetchable after a longer
delay than 10 minutes - possibly something time-related on the game's
own backend - so giving up permanently after the first 10 minutes meant
those would only ever get picked up again by tapping Fetch/Update by
hand. See `retryPendingItems` in `app/src/api/fetchAllForWallet.js` and
the timer itself (including the fast/slow pacing logic) in `App.js`.

Also hardened `imageStorage.js` at the same time: an image download now has
its own 15-second timeout (independent of the metadata request's own
timeout), and a downloaded file that comes back suspiciously small is
treated as a failed download and deleted rather than kept - some hosts
answer with an HTTP 200 status but an error page's HTML instead of the
actual picture on a bad day, and without this check that would have been
mistaken for a successfully cached image and never retried.

## Retry banner now says which kind of retry is happening

The background auto-retry timer above (and the manual Fetch button) can
end up doing two quite different kinds of work at once for the same
wallet:

- **NFT refetch** - an item is stuck in `failed` status, meaning its
  whole record (name, image URL, every trait) never came back
  successfully, so the app has to ask the metadata API for everything
  again.
- **Image refetch** - an item's data came back fine (`status: 'ok'`) but
  its picture never got downloaded and saved to the phone, so the app
  only needs to fetch and cache the image, not re-ask for any of the
  trait data.

Previously the on-screen banner just showed a single combined count,
which read like "retrying 3 items" with no way to tell what kind of work
that meant. `countPendingRetries` (in `app/src/db/database.js`) now
counts these two kinds separately instead of returning one number, and
`App.js` uses that breakdown to build a message like "Retrying: 2 NFT
refetches and 1 image refetch". The per-item progress labels used while
that work runs (in `retryPendingItems`, `app/src/api/fetchAllForWallet.js`)
were updated the same way, e.g. "Devikins (NFT refetch)" vs. "Devikins
(image refetch)", so it's clear from the banner alone which kind of
retry is in progress at any moment. `ProgressBar.js` gained a small new
`summary` display mode to show this kind of pre-written message as-is,
without wrapping it in its usual "Looking up..." phrasing.

## Bug fixed: results looked different on every Fetch

Found and fixed a real bug: `upsertNft` in database.js used to overwrite
ANY existing row for a nonce, including on a purely transient failure (a
timeout, after all retries were exhausted). So if an NFT had previously
been fetched successfully (image, traits, everything) and a *later* Fetch
happened to hit one of the metadata API's routine timeouts for that one
item, the app would silently replace the good row with a blank
`status: 'failed'` row - erasing data we already had, over a hiccup that
had nothing to do with that NFT actually changing. This is almost
certainly why the app appeared to show different results each time you
tapped Fetch.

Fixed: a transient-failure write for a nonce that already has a
successful (`status: 'ok'`) row now does nothing at all - the existing
good data is left untouched, and the next Fetch will simply try that item
again. A transient failure only gets written as a visible `failed` row
the first time an item has never been successfully fetched before.

## Weapons list/detail view and card layout

The Weapons tab now works the same way the Devikins tab does, since it
turned out to be a natural next step once Devikins had it:

- **List** (`WeaponSummaryRow.js`): a compact, tappable row per weapon -
  picture on the left, Rarity/Type/Quality stacked on the right (the
  weapon equivalent of Devikins' Rarity/Ancestry/Personality - the three
  fields that most say "what this item fundamentally is" before you tap
  in for combat stats). This is a first pass at which three fields to
  show - easy to change if you'd rather see something else here.
- **Detail** (`NftCard.js`'s new hand-arranged weapon layout): shown when
  you tap a row, with a "Back" link to return to the list. Grouped as:
  Name/nonce at top, then a separator, Rarity/Type/Quality in three
  columns, another separator, Shiny/Slot/Element/Resistance Type/Gene
  Sync as chips, another separator, the five combat stats (Scaling,
  Critical Chance, Critical Damage, Speed Modifier, Accuracy, Refine XP)
  two per row, another separator, then Base Durability/Durability/
  Improvement Level in three columns. Anything not explicitly placed
  still shows up in a catch-all row at the bottom, same safety net as the
  Devikin layout.

`CollectionView.js` no longer special-cases "devikin" by name for this -
it now looks up which collections have their own summary row via a small
`SUMMARY_ROW_COMPONENTS` table (currently `devikin` and `weapon`), so
adding this same list/detail treatment to Equipment later (if wanted)
will just mean writing an `EquipmentSummaryRow.js` and adding one line,
rather than restructuring `CollectionView.js` again.

Equipment is unaffected for now - still shows its full card directly in
the list, since no layout instructions have been given for it yet.

*(Update: Equipment got the same treatment shortly after too - see
"Equipment list/detail view and card layout" below. All three
collections now work the same way.)*

## Equipment list/detail view and card layout

Equipment now works the same way Devikins and Weapons do:

- **List** (`EquipmentSummaryRow.js`): a compact, tappable row per item -
  picture on the left, Rarity/Type/Quality stacked on the right, same
  three fields as Weapons for consistency. You've said you want to think
  through the exact fields more once you've seen it in action, so treat
  this as a starting point rather than a final answer.
- **Detail** (`NftCard.js`'s new hand-arranged equipment layout): shown
  when you tap a row, with a "Back" link to return to the list. Grouped
  as: Name/nonce at top, then a separator, Rarity/Type/Quality in three
  columns, another separator, Shiny/Slot/Resistance Type as chips (fewer
  than Weapons - Equipment doesn't have Element or Gene Sync), another
  separator, the four defensive stats (Protection, Evasion, Guard,
  Resistance) two per row, another separator, then Accuracy/Improvement
  Level/Refine XP in three columns (the equipment equivalent of Weapons'
  durability group - "stats about upgrading/using this item"). Anything
  not explicitly placed still shows up in a catch-all row at the bottom,
  same safety net as the other two layouts.

`CollectionView.js`'s `SUMMARY_ROW_COMPONENTS` table now has all three
collections in it (`devikin`, `weapon`, `equipment`), so every tab
behaves the same way. The plain "generic" image-left/chips-below layout
that all three collections originally shared is still in `NftCard.js` as
a fallback, but nothing currently reaches it - it would only be used if
a brand new collection got added before it had its own custom layout.

## Loading screen title

While the local database is doing its brief one-time setup when the app
first opens (see `initDatabase()` in App.js), it now shows "Devikins" and
"Legacy" as a two-line title, in the app's primary accent color, with the
existing "Setting up local database..." message underneath as a smaller
status line. This isn't a separate splash screen asset, just the same
loading state App.js already had, given a proper title instead of plain
text.

**Update:** the database itself finishes setting up almost instantly
(well under a second), so the title was flashing by too fast to actually
read. Per feedback that it should last 3-5 seconds, the startup code now
also waits on a plain 4-second timer alongside the real database setup,
and only moves on once BOTH are done (`Promise.all` in App.js's startup
`useEffect`) - so the loading screen now holds for a fixed 4 seconds
regardless of how fast the database itself is. If the database ever did
take longer than 4 seconds on some phone, this still works safely: it
waits for whichever of the two takes longer, so real setup is never cut
short.

## Building a real APK, and sharing on GitHub

Set the app up to be built as a standalone, installable Android `.apk`
file (not just run through Expo Go) using Expo's free EAS Build service:

- `app.json` now has a real name (originally "Devikins Legacy", matching
  the loading screen at the time - later renamed to "Devikins Legacy
  Companion", see the "App renamed" section further down) and slug, plus
  an `android.package` identifier (`com.raphaelrohner.devikinslegacy`) -
  EAS Build requires this to exist before it can build anything for
  Android. The slug and android.package were deliberately left as-is
  during the rename - these are internal identifiers (used for EAS/Play
  Store bookkeeping), not user-facing names, and changing android.package
  in particular after an app has ever been installed on a real device
  would make a future update look like a totally different app to
  Android. Neither has been used in a real build yet, but leaving them
  fixed now is one less thing to think about later.
- Added `app/eas.json` with a `preview` build profile set to produce a
  plain `.apk` (`android.buildType: "apk"`, `distribution: "internal"`),
  rather than the `.aab` format the Google Play Store requires - this app
  has no reason to go through the Play Store, so a directly-installable
  file is the right target.
- Full step-by-step instructions (installing `eas-cli`, logging in,
  running the build, installing the resulting `.apk` on a phone) are now
  in `app/SETUP.md`'s "Building a real, installable app" section - this
  has to be run from a real Terminal with an internet connection, not
  from within this assistant's own sandbox, since EAS Build uploads the
  project to Expo's servers and builds it there.
- `SETUP.md` also has a short section on optionally hosting the project
  (and its built `.apk`) on GitHub - the code as a repository, the
  built app as a downloadable file attached to a GitHub Release. Nothing
  has been set up for this yet (the project folder isn't a git repository
  yet) - it's just documented as an option for whenever it's wanted.

**Update:** `SETUP.md` now also documents a second, fully local way to
build the APK, with no cloud build service (and no Expo account)
involved at all - the JavaScript/React Native equivalent of building a
Python app locally with something like Buildozer. The short version:
`npx expo prebuild --platform android` turns this project into a real,
ordinary Android Studio/Gradle project (the `android/` folder), and from
there `./gradlew assembleDebug` (quick, auto-signed, fine for your own
phone) or `./gradlew assembleRelease` (needs a signing key you generate
yourself with `keytool`, meant for a build you'll keep updating over
time) produces the `.apk` directly on your own Mac. This trades EAS
Build's "no local setup needed" convenience for "nothing leaves your
computer" - it needs Android Studio installed locally first (a real,
one-time chunk of setup), whereas EAS Build only needs the free eas-cli
tool and an Expo account. Neither path has been run yet - both are
documented in SETUP.md for whenever it's wanted.

## Database design decisions

- Three tables: `devikin`, `weapon`, `equipment` — one row per nonce.
- Known traits get their own real columns (typed as INTEGER for numbers,
  TEXT for categories) based on the trait survey. This is what makes
  filtering fast and simple.
- Every row ALSO stores the complete raw API response in a `raw_json`
  column. This means we never lose data, even for a trait the schema
  doesn't have a column for yet.
- If a fetch ever returns a `trait_type` that isn't one of the known
  columns, the app logs it to the console rather than silently dropping it
  (it's still safe in `raw_json` either way) — this is how we'd notice the
  game added a new trait we should add a proper column for later.
- A small extra `settings` key/value table (same database file) stores
  the last wallet address the user fetched, so re-opening the app shows
  that wallet's already-saved NFTs immediately, offline, without forcing
  a network fetch. Tapping Fetch still re-checks the network as normal
  (see the caching-with-revalidation note above) - this only saves you
  from re-typing the address and waiting on a network call just to see
  data you already had.
- Each row also has a `local_image_path` column: the first time an NFT's
  image is successfully fetched, the app downloads the actual picture to
  the phone's own storage (see `app/src/api/imageStorage.js`) and remembers
  that local path, instead of only remembering the remote URL and asking
  the image host for the picture again every time it's displayed. This
  column was added after the tables already existed on a real phone, so
  `database.js` has a small `ensureColumn` migration helper that adds it
  to any database file that doesn't have it yet, rather than assuming
  everyone's starting from a brand new database.
  **Known trade-off:** this assumes an NFT's picture never changes once
  cached. Traits are allowed to (see the "metadata is NOT permanent" note
  above), and if the game ever changes an NFT's artwork too, this cache
  would keep showing the old picture until it's cleared. Worth revisiting
  if that ever actually happens - `imageStorage.js`'s file comment has a
  concrete suggestion for how to detect it.
- Every row has `owner_address`, `fetched_at` (when we last successfully
  looked at it), and `status` (`ok` / `unavailable` / `failed`):
  - `ok` — fetched successfully, real data present.
  - `unavailable` — the metadata API cleanly said "not found" (HTTP 404).
    Treated as permanent; the app will not retry these on future fetches.
  - `failed` — a temporary problem (timeout, server error) that used up
    all its retry attempts. Unlike `unavailable`, these ARE retried on a
    future fetch, since the problem might just be the Lambda being flaky
    that one time.

## Fullscreen image viewer

Tapping a picture anywhere it's shown in a detail view (Devikins,
Weapons, or Equipment - `NftCard.js` covers all three) now opens it
fullscreen: a near-black overlay with the picture shown as large as
possible, an explicit "✕" button in the top corner, and tapping anywhere
else on the overlay also closes it. This uses React Native's own `Modal`
component, which is built for exactly this - content that should cover
the whole screen no matter where it's placed in the component tree.

Only the actual picture is tappable - the "Unavailable" placeholder
isn't, since there's nothing to view fullscreen in that case. Both the
standard-size and 100%-larger (Devikin-only) images feed the same
fullscreen viewer and share one open/closed flag, since only one image is
ever showing per card. List rows (the compact tappable rows shown before
you open a detail view) are unaffected - fullscreen viewing is only from
the detail view's own picture.

## Devikin gene section: two columns instead of wrapping chips

The five gene traits (Eyes/Mouth/Ears/Hair/Horns Gene) were shown as
chips that wrapped onto as many chips-per-row as happened to fit,
depending on each value's text length - not a predictable layout. Per
feedback, these are now arranged into an explicit two-column grid instead
(`geneGridPairs` in NftCard.js: Eyes+Mouth, Ears+Hair, and Horns alone on
its own row, since five doesn't divide evenly into two), so they always
line up the same way regardless of value length.

## Rotates with the phone now

The app was locked to portrait-only (`app.json`'s `"orientation":
"portrait"`) since that's what `create-expo-app` sets up by default.
Changed it to `"orientation": "default"`, which lets the OS rotate the
app to landscape when the phone itself is turned sideways, same as most
apps. No layout changes were needed for this - every screen is already
built with flexbox (rows/columns that reflow based on available space,
not fixed pixel positions), so it adapts to landscape's wider/shorter
shape on its own. Since this is an `app.json` setting rather than a code
change, it needs the dev server restarted (stop it with `Ctrl+C`, then
`npx expo start` again) rather than just reloading the app on the phone,
for Expo Go to pick up the new value.

## Bug fixed: couldn't scroll past an expanded filter panel

Reported as "I select e.g. Uncommon [for Rarity] but can't scroll down" -
the filtering itself was actually working fine; the real problem was
that once the filter panel was expanded, there was no way to scroll past
it. `CollectionView.js` used to render the filter panel as a plain,
separate `View` sitting above the results list, outside the list's own
scrolling area - fine while collapsed, but a Devikin has over 20
filterable traits, each its own row when expanded, easily taller than
the whole screen. Everything below that - remaining filter rows, and the
entire results list - was stuck below the visible area with nothing to
scroll it into view, since only the `FlatList` itself scrolled, not its
surroundings.

Fixed by passing the filter panel in as the `FlatList`'s own
`ListHeaderComponent` instead of a separate sibling - this makes it part
of the exact same scrollable area as the list below it, so scrolling
down always works now no matter how many filters are showing. The
loading spinner and "no results" messages were folded into
`ListEmptyComponent` the same way, for the same reason (and as a nice
side effect, the filter panel now also stays visible and scrollable
during the brief moment a fresh query is loading, instead of
disappearing).

## Filters now need an explicit "Apply Filters" tap

Previously, every single change in the filter panel - picking a dropdown
value, typing a character into a min/max box - immediately re-queried
and re-rendered the list. Per feedback, `FilterPanel.js` now splits this
into two steps:

- `pendingFilters` - what the dropdowns/boxes currently show, updated
  instantly as you interact with them, same as before.
- `appliedFilters` - what's actually been sent up to `CollectionView`
  (and therefore what the list is actually querying by) - only updated
  when the new "Apply Filters" button (shown at the bottom of the
  expanded panel) is tapped.

The button greys itself out (using the same `colors.primaryDisabled`
look as the Fetch/Update button's disabled state) whenever
`pendingFilters` already matches `appliedFilters`, so there's nothing to
apply. This means you can now pick several filters one after another
without the list jumping around after every single choice - only once
you're happy with the selection and tap Apply.

**Update:** once a selection is actually applied (and nothing new is
pending), the same button now turns into a red-tinted "Remove Filters"
button instead of staying a greyed-out "Apply Filters" - tapping it
clears every control back to "All"/empty and tells the list to show
everything again, all in one tap, rather than having to reset each
dropdown by hand. The moment you pick something different again, it
switches back to an active "Apply Filters" button. `showRemoveButton` in
`FilterPanel.js` is what decides which of the two is currently showing.

**Update:** moved this button from the bottom of the expanded panel to
right below the "Show filters"/"Hide filters" toggle, per feedback -
pinned at the top rather than after however many filter rows there are
(over 20 for Devikins), so it's always immediately visible without
scrolling down through the whole list of filters first.

**Update:** that "pinned at the top" version was still technically part
of the same scrollable area as the filter rows below it - so a long
finger-swipe could still carry it out of view along with everything
else. Fixed properly this time by splitting `FilterPanel.js` in two:

- `CollectionView.js` now owns the "Show filters"/"Hide filters" toggle
  and the Apply/Remove Filters button itself, rendering them as a plain
  sibling directly above the results list rather than inside it - so
  they're truly fixed on screen and can never be scrolled away, no
  matter how far down the list you go.
- `FilterPanel.js` now only draws the actual filter rows (the dropdowns
  and min/max boxes), still placed inside the list's scrollable area so
  the "can't scroll past the filters" bug from earlier stays fixed too.

Both pieces share the same picks (`pendingFilters`/`appliedFilters`),
which now live in `CollectionView.js` and get passed down to
`FilterPanel.js`.

Per further feedback, tapping either button now also collapses the
filter rows back closed automatically (the "Show filters ▼" toggle
reappears, ready to be tapped again) - so applying or removing a
filter selection tidies the screen back up instead of leaving a long
list of filter rows sitting open underneath the results.

**Update:** once a filter selection is actually applied, a small
"Remove filters ✕" link now shows up on the right-hand side of the
"Show filters"/"Hide filters" toggle itself - so a filter can be
cleared in a single tap without needing to expand the panel first.
The separate full-width "Remove Filters" button (which used to replace
"Apply Filters" below the toggle once nothing was pending) is gone -
that spot now only ever shows "Apply Filters", and only while the
panel is expanded and there's a new pick waiting to be applied.

## Multiple wallets, and marking NFTs as deleted

Two related features added together, both per feedback:

### Multiple wallets

The app used to only ever track one wallet address at a time (typed
into a text field at the top, remembered between opens). It now
supports any number of wallets:

- A new `wallets` table in the database (`database.js`) stores every
  address you've added - just an id, the address itself, and when it
  was added.
- A **Wallets** button next to Fetch/Update opens a dedicated screen
  (`WalletManager.js`) with the classic CRUD buttons: paste an address
  and tap **Add**; tap **Edit** on any saved address to fix a typo (or
  **Delete** to remove it - this only stops that wallet from being
  fetched/shown, it doesn't erase any of its already-saved NFT data,
  so re-adding the same address later brings it right back).
- **Fetch/Update** now loops over every saved wallet, one at a time
  (not in parallel - see `fetchAllForWallets` in
  `fetchAllForWallet.js` for why: the metadata API is already flaky
  under light load, so fetching multiple wallets at once would only
  make that worse). When there's more than one wallet, the progress
  bar says which one it's currently on ("Wallet 2 of 3: ...").
- The three tabs now show NFTs from **every** saved wallet combined,
  not just one - `queryNfts` and the filter-option-loading queries in
  `database.js` all changed from "match this one owner_address" to
  "match ANY of these owner_addresses".
- **Upgrading from before this feature existed:** the single
  previously-remembered wallet address is carried over into the new
  `wallets` table automatically, the first time the app opens after
  this update - so existing data and the wallet you'd already been
  using don't just disappear. This only happens once (see
  `initDatabase`'s migration step in `database.js`).

### Marking NFTs as deleted, with a note

Every NFT's detail view now has a **Notes** box and a **Mark as
Deleted** button at the very bottom (below all its stats). This is a
soft flag, not a real delete - nothing is ever removed from the
database:

- Two new columns, `deleted` (yes/no) and `comment` (free text), were
  added to all three NFT tables.
- Marking something deleted saves whatever's in the Notes box as its
  comment and flags it, greys it out (using the same dimmed look on
  the picture and its row, but it's still tappable to open the detail
  view) in that collection's list, and drops it out of the results
  entirely if the **Deleted** switch (see below) is turned on.
- Once marked deleted, that same button turns into **Restore** - this
  wasn't explicitly asked for, but felt necessary once there's a way
  to mark something deleted at all, so a mistaken tap (or just
  changing your mind) is never a dead end. Restoring keeps whatever's
  currently in the Notes box, so you can also tidy up or clear the
  note at the same time if you want.
- A new **Deleted** switch sits next to the "Show filters" toggle,
  off by default. Off means deleted items still show (greyed out, as
  above); switching it on excludes them from that tab's results
  entirely until switched back off.

This is entirely a personal organizing tool - it has nothing to do
with the actual blockchain or the NFT itself, which obviously can't be
"deleted" by this app. It's meant for things like marking an item
you've sold on the marketplace, or a duplicate you're keeping the
other copy of, so your own list stays easy to scan without losing
track of it entirely.

**Clarified behavior (not a bug):** `upsertNft` in `database.js` saves
a full replacement row on every successful re-fetch, and that row
doesn't carry the `deleted`/`comment` values forward - so if an NFT
that was marked Deleted gets successfully re-fetched, its Deleted flag
and comment are cleared automatically. This looks like a bug at first
glance, but it's the correct behavior for what Deleted actually means
here: Fetch/Update only ever re-fetches nonces the wallet *currently*
holds (per the blockchain), so a successful re-fetch of a given nonce
is itself proof you still own it - meaning it was never actually sold
or given away, so it shouldn't stay marked Deleted. An NFT you truly
did sell/give away simply stops appearing in future fetches entirely
(the wallet no longer holds that nonce), so its Deleted flag and
comment are never touched again and stay exactly as you left them.
Deliberately left as-is - do not "fix" this to preserve `deleted`/
`comment` across a re-fetch.

## Four small UI tweaks (post-multi-wallet feedback)

A batch of small refinements, all per feedback after trying out the
multi-wallet and deleted-items features above:

- **Active-item count next to "Show filters".** Each tab now shows a
  count like "142 Devikins" sitting between the "Show filters" toggle
  and the "Deleted" switch. This always counts NOT-deleted items only,
  regardless of whether the Deleted switch itself is on or off, or
  what filters are applied - it's meant to answer "how many active
  items do I have in this category", not "how many rows match my
  current filter". Backed by a small extension to `countNfts` in
  `database.js` (it now takes an `excludeDeleted` flag, mirroring how
  `queryNfts` already worked).
- **Wallets button now matches Fetch/Update's colour.** Previously a
  neutral grey/bordered button; now the same solid accent colour as
  Fetch/Update, for visual consistency (`App.js`).
- **"‹ Back to Home" is now centred** on every NFT detail page
  (Devikins, Weapons, Equipment all share this button in
  `CollectionView.js`) - it used to sit against the left edge.
- **NFT ID shown above Rarity** in every collection's list view. Each
  row now shows "#<nonce>" as its own line, right below the "Deleted"
  tag (when present) and above Rarity/Ancestry/Personality (or
  Type/Quality) - and unlike those stat lines, the ID always shows
  even if the metadata fetch failed, since the nonce itself is always
  known regardless (`DevikinSummaryRow.js`, `WeaponSummaryRow.js`,
  `EquipmentSummaryRow.js`).

## Naming wallets

Wallet addresses are long and hard to tell apart at a glance, so each
one can now be given an optional friendly name (e.g. "Main",
"Trading"):

- A new `alias` column was added to the `wallets` table (nullable -
  a wallet with no name given just has `alias = NULL`).
- The name is set from the same **Edit** mode used to fix a typo'd
  address - a second text box appears underneath the address field
  when editing, labeled "Name this wallet (optional)".
- Once saved, the name shows up on the wallet's row on the right side
  of the Edit/Delete buttons, so it's a quick visual tag without
  taking up its own line. A wallet with no name just shows nothing
  there - same layout, no placeholder text.
- This is purely cosmetic/organizational, like the deleted/comment
  feature above - it has no effect on fetching or on how the NFT data
  itself is stored (still keyed by the wallet's actual address).

## Bug fixed: list flickering and jumping to the top during a fetch

While a fetch was running, the results list would flicker and reset its
scroll position back to the top, over and over, instead of just quietly
updating once each collection finished.

The cause: `App.js` computed `walletAddresses` (the list of wallet
addresses passed down to `CollectionView.js`) fresh on every render,
with no memoization - `wallets.map(w => w.address)`. That's normally
harmless, but a fetch calls `setProgress` very often (every item that
comes in), and each of those re-renders `App.js`. Every one of those
re-renders handed `CollectionView.js` a brand-new array - same
addresses, but a different object in memory - and `CollectionView.js`'s
effects (reloading the list, the filter options, and the active-item
count) all treat "a new `ownerAddresses` array" as "the data changed,
reload everything", since that's normally how "the user added/removed a
wallet" shows up. So they were re-running dozens of times a second, and
each one briefly cleared the list to empty while it re-queried - which
is what actually caused the flicker and the jump back to the top (an
empty list has nothing to keep a scroll position against).

The fix: `walletAddresses` is now wrapped in `useMemo(..., [wallets])`,
so it only gets a new identity when the saved wallet list actually
changes (add/edit/delete), not on every progress update. The list now
only reloads at the two points that were always intended: once when a
collection finishes fetching, and once when the whole fetch ends.

**Follow-up:** even after the fix above, the list still jumped back to
the top at those two intended reload points (once mid-fetch, once at
the end). The cause this time was `CollectionView.js` itself: while a
reload was in flight, it fed the list `[]` (an empty array) instead of
its current rows, so the list briefly had nothing in it - and a list
with nothing in it has no scroll position to preserve, so it always
came back showing item 1. `reloadRows` now only clears the list like
that when actually switching to a different collection (Devikins ->
Weapons, say) - a same-collection reload (a fetch finishing, applying
filters, the Deleted switch) instead keeps the current rows on screen
and swaps in the new ones directly once they're ready, with no empty
gap in between to reset the scroll position.

## Four more small polish tweaks

Another round of small feedback, all cosmetic:

- **Light/dark toggle now matches Fetch/Update and Wallets.** Same
  rounded-rectangle shape and padding as those two buttons (it used to
  be a smaller rounded "pill" with a border), still showing the ☀️/🌙
  icon next to the "Light"/"Dark" label. Kept a muted/neutral
  background rather than the solid accent color Fetch/Update and
  Wallets use - the same "muted button" look already used for
  Edit/Cancel in `WalletManager.js` - since it's a settings toggle, not
  a primary action.
- **Top row now lines up with the tabs below it.** The Fetch/Update,
  Wallets, and theme-toggle row already had 12px of side padding; the
  Devikins/Weapons/Equipment tab bar didn't, so it looked slightly
  wider than the row above it. The tab bar now has the same 12px side
  padding around its buttons, so both rows line up - its background
  color and bottom border still span the full screen width either way,
  since padding only affects where the tab buttons themselves sit, not
  the bar's own background.
- **"‹ Back to Home" is now full-width** on NFT detail pages, instead
  of a small centered pill - stretching edge-to-edge with the same side
  margins used elsewhere on screen.
- **One-time "this will take a while" popup.** The moment you add your
  very first wallet ever (the wallets list is still empty right before
  you tap Add), a popup explains that tapping Fetch/Update next will
  take a few minutes the first time, since nothing's cached yet. It
  doesn't show again for any wallet added after that first one.

## Equal-width top buttons, Wallets moved closer to Fetch/Update

Fetch/Update, Wallets, and the theme toggle used to each be exactly as
wide as their own label needed, spread across the row with even gaps
(`justifyContent: 'space-between'`) - which put Wallets roughly
centered between Fetch/Update and the toggle rather than near either
one.

- All three now share one fixed width (`ACTION_BUTTON_WIDTH` in
  `App.js`, currently 118), so they read as one consistent row of
  same-size buttons regardless of label length. Fetch/Update's own side
  padding was trimmed a little to fit that shared width comfortably.
- Briefly tried grouping Fetch/Update and Wallets together so Wallets
  sat right next to Fetch/Update, but per feedback that made Wallets
  look off-center rather than better - it's back to being a plain
  sibling of Fetch/Update and the theme toggle in `controlsRow`, with
  the row's own `space-between` spacing all three evenly. With all
  three the same width, that math naturally lands Wallets exactly in
  the middle of the row (Fetch/Update flush left, the toggle flush
  right) - no separate "centered" logic needed, it falls out of equal
  widths + space-between.

## Android's system Back button/gesture now works as expected

An audit against Google's own Android design guidelines turned up a
real (not just cosmetic) gap: this app never uses a navigation library
(see the file comments in `App.js`/`CollectionView.js` for why - it's
all just plain state deciding what to render), and it never listened
for Android's hardware/gesture Back action either. That combination
meant pressing system Back while looking at the Wallets screen, or an
NFT's detail view, would quit the app outright instead of taking you
back to the home screen or the list - since as far as Android was
concerned, there was nothing to "go back" to.

Fixed with React Native's `BackHandler`, in two places, each only
active while its own screen is actually open:

- `App.js` closes the Wallets screen on Back (same as tapping its own
  "‹ Back to Home" button) whenever `showWalletManager` is true, and
  otherwise steps aside and lets Android do its normal thing (exit the
  app, same as always on the home screen).
- `CollectionView.js` closes an open NFT detail view on Back the same
  way, whenever one is showing (`isDetailViewOpen`) - and otherwise
  also steps aside.

The two listeners never conflict, because `CollectionView.js` isn't
even mounted while the Wallets screen is showing (App.js swaps between
them), so only one of the two is ever actually listening at a time.
Everything else about the Back button - like exiting from the home
screen itself - is untouched; this only adds the two "close this
screen first" steps that were missing before.

## "Show filters" and "Remove filters" turned into real buttons

The same Android design audit flagged "Show filters"/"Hide filters" and
"Remove filters ✕" as the smallest tap targets in the whole app - they
were plain colored text with no padding around them at all, so their
tappable area was only as big as the text itself.

Both now get the same "real button" treatment already used elsewhere
in the app (a background, a border, and generous padding) instead of
bare text - noticeably bigger and easier to tap, and they now read
visually as buttons too, not just colored links.

## Rarity filter sorted by rarity, not alphabetically

Every text filter's dropdown options come straight from the database in
alphabetical order (see `getDistinctColumnValues` in `database.js`) -
fine for something like Ancestry or Personality, but for Rarity it put
"Common" after "Eldritch", which reads backwards from how rarity
actually works.

Rarity now gets its own explicit order instead: All, Common, Uncommon,
Rare, Mythic, Eldritch - a `RARITY_ORDER` list in `schema.js` that
`CollectionView.js` uses to re-sort just that one column's options
after loading them (every other text filter is untouched, still
alphabetical). If a rarity value ever shows up that isn't in that list
(say the game adds a new tier), it doesn't disappear or crash anything
- it just gets tacked on at the end, after the known ones.

## "Reset All Data" button, for testing from scratch

Came up while getting ready to test the app again from a clean state:
the saved wallets, NFTs, and downloaded images all live in the app's
own storage on the phone, completely separate from Expo's dev server -
so "restarting Expo" (or even clearing its bundler cache) doesn't touch
any of that. The only other way to truly start over would have been
clearing Expo Go's storage from the phone's own Settings app - which
wipes every OTHER Expo Go project on the phone too, not just this one,
since they all share the same app.

Added a proper in-app way to do it instead: a "Danger zone" section at
the bottom of the Wallets screen, below the wallet list, with a "Reset
All Data" button. Tapping it asks for confirmation first (unlike
deleting a single wallet, which doesn't - this one's genuinely
destructive and worth pausing for), then:

- `resetAllData()` in `database.js` empties the `devikin`, `weapon`,
  `equipment`, and `wallets` tables - not dropping/recreating them,
  just clearing every row, so there's nothing for `initDatabase`'s
  migrations to redo on the next launch.
- `deleteAllStoredImages()` in `imageStorage.js` deletes the whole
  folder of downloaded NFT images, so nothing orphaned is left behind
  for NFTs that no longer have a database row.

Afterward the app looks exactly like a fresh install - no wallets, no
NFTs, the "Tap Wallets below to add a wallet address..." hint, and the
first-wallet popup will fire again the next time one's added. Your
actual NFTs are never affected either way - this only touches what
this one phone has saved locally.

## Bug fixed: filter panel stayed open across a tab switch

Switching tabs already reset the open NFT detail view (back to the
list) and reloaded the data, but the expanded filter panel itself
stayed open if it had been open on the previous tab - showing that
other collection's trait rows for a moment, or just being generally
confusing to leave open across a switch. `CollectionView.js`'s
existing "reset stuff when kind/ownerAddresses changes" effect now
also collapses the panel (`setExpanded(false)`), so switching tabs
always lands on a clean, collapsed filter bar - and the next time you
open it, its options get a fresh reload rather than showing whatever
was already loaded for the tab you left.

## Bug fixed: layout broke once "Remove filters" could actually appear

"Show filters", the active-item count, the Deleted switch, and
"Remove filters" all used to sit crammed onto one row. That was fine
back when Show filters and Remove filters were just bare text with no
padding - but once both got turned into real buttons (per the Android
touch-target audit), that same row no longer had enough width to fit
everything once "Remove filters" actually appeared (it only shows up
once a filter is applied), and the row wrapped/broke.

Split into two separate rows to fix it, then rearranged per feedback
into their final positions:

- Row 1: "Show/Hide filters" on the left, "Remove filters" on the
  right (only when a filter is applied - "Show filters" just sits
  alone on the left when there's nothing to remove).
- Row 2: the active-item count centered, the Deleted switch pinned to
  the right edge.

Row 2's true centering (the count staying centered in the whole row,
not just in whatever space is left over next to the Deleted switch)
first used a flexbox trick: two equal, invisible `flex: 1` spacer
regions, one on each side of the count text. That didn't actually work
in practice - React Native flex items don't shrink below their content
size by default, so the side holding the (wider) Deleted switch quietly
claimed more than half the row, and the count still looked shifted
left instead of centered.

Fixed by centering the count text with absolute positioning instead
(`position: 'absolute'`, `left: 0`, `right: 0`, `textAlign: 'center'`),
which centers it purely against the row's own width and ignores the
Deleted switch entirely - no more drifting off-center regardless of how
wide the switch is.

## Count and Deleted switch only move to their own row when needed

Following on from the two-row split above: the count and Deleted
switch used to always sit on their own second row, even when "Remove
filters" wasn't showing and there was plenty of room for everything on
one line. Per feedback, they now only drop down onto a second row once
Remove filters actually appears and needs the space:

- No filters applied: one row - "Show filters" on the left, the count
  centered, the Deleted switch on the right.
- A filter applied: two rows - "Show/Hide filters" and "Remove
  filters" on row 1 (left/right); the count (centered) and Deleted
  switch (right) drop down to row 2.

The count and Deleted switch are defined once (`countAndDeletedSwitch`
in CollectionView.js) and reused in whichever spot needs them, rather
than duplicated - only one of the two spots ever renders it at a time,
so this is safe. The row that's rendering them also needs
`position: 'relative'` (for the count's absolute centering to work
against whichever row it's currently in), and only gets its own bottom
padding when it's the last row on screen - both are handled in the
component's styles.

## Bug fixed: "Show filters" stopped responding to taps

Right after the change above, tapping "Show filters" did nothing -
the button was visible but completely unresponsive. Cause: the count
text centers itself by stretching an invisible box across the *entire*
row, edge to edge (`left: 0`, `right: 0`), then centering the visible
text within that box. That's harmless when the count has a row to
itself, but once it started sometimes sharing a row with the Show
filters button, that invisible box ended up sitting right on top of
the button - and being layered on top, it silently absorbed every tap
meant for the button underneath, even in the parts of the row where no
text was actually visible.

First attempt: `pointerEvents="none"` directly on the count `<Text>`,
to make it purely decorative from a touch perspective so taps pass
straight through to whatever's underneath. This helped, but Raphael
found it only worked "every now and then" - still unreliable on his
phone, not fixed.

Root cause of the flakiness: `pointerEvents="none"` on a bare `<Text>`
is a known weak spot on Android - it isn't always honored consistently
the way it is on a plain `<View>`. Fixed properly by wrapping the count
text in an ordinary `<View pointerEvents="none">` and putting the
absolute positioning on that wrapping View instead of on the Text
directly - Views handle `pointerEvents="none"` far more dependably on
Android, so taps now pass through to the Show filters button
underneath every time, not just occasionally.

## Loading screen shortened from 4 to 3 seconds

The "Devikins Legacy Companion" loading screen has a fixed minimum display time
(`MIN_SPLASH_DURATION_MS` in App.js) so it doesn't flash by too fast to
read, since the actual database setup underneath it finishes almost
instantly. Per feedback it was shortened from 4 seconds to 3.

## App renamed to "Devikins Legacy Companion", version shown on splash

Reconsidered the app's name - the working name "Devikins Legacy" plus a
description like "NFT Scanner" (and a version number baked into the name
itself) read as long, technical, and version-numbers-in-a-name age
badly (what happens at V2?). Settled on **Devikins Legacy Companion**
instead - keeps the existing "Devikins Legacy" branding (unchanged on
the loading screen, already used in `app.json`), adds a warm, simple
second half, and drops "Scanner"/"NFT" from the name itself since the
app is more of a browsing companion than a one-off lookup tool, and
"vault"/"collection" both wrongly imply something is stored/managed
here beyond what's already on the blockchain.

Changes:

- `app.json`'s `name` field updated to "Devikins Legacy Companion" -
  this is what shows under the icon on the phone's home screen. The
  `slug` and `android.package` were deliberately left untouched (see the
  note added to the "Building a real APK" section above).
- The loading screen now shows "Devikins" / "Legacy" (unchanged, still
  the big two-line title) with "Companion" underneath as a smaller
  tagline - part of the name, but not given equal visual weight.
- Added the app's version number, shown small at the very bottom of the
  loading screen (`position: 'absolute'`, so it's pinned to the bottom
  of the whole screen rather than just trailing after the other
  centered text). Pulled directly from `app.json`'s `version` field
  (via a plain JSON import) rather than typed in separately, so it can
  never drift out of sync with the number a real APK build actually
  uses.
- All the docs' own titles (this file, SETUP.md, TESTING.md) updated to
  match. ARCHITECTURE.md's title didn't reference the app name and
  didn't need changing.

**Bug fixed (round 1):** the version number didn't actually show up.
The first attempt put `position: 'absolute'` directly on the version
`<Text>` with `alignSelf: 'center'` to center it - unlike the same
`left: 0` / `right: 0` approach already used for the NFT count text (see
CollectionView.js's `countTextWrap`), this didn't render at all.
Switched it to that same already-proven pattern instead - a plain
wrapping `View` with `position: 'absolute'`, `left: 0`, `right: 0`, and
`bottom: 24`, with the Text just centered inside it via `textAlign:
'center'`. Worth remembering for next time: stick to the left/right
version of this trick rather than alignSelf on a bare absolutely-
positioned Text.

**Bug fixed (round 2):** still not visible after that - Raphael's
Android navigation bar (the gesture pill / 3-button bar along the
bottom of the screen) was covering it. SafeAreaView is supposed to
automatically keep content clear of exactly this kind of system UI, but
on his device it wasn't reserving quite enough space for it. Fixed by
reading the actual bottom inset directly with `useSafeAreaInsets()`
(from the same `react-native-safe-area-context` package) and using
`insets.bottom + 16` for the version text's bottom offset, instead of a
plain fixed number - this guarantees clearance above whatever the
device's real navigation bar height is, rather than trusting
SafeAreaView's own automatic padding to have gotten it exactly right on
every device.

## Real app icon, replacing the default Expo template artwork

Every icon asset (`assets/icon.png`, `favicon.png`, `splash-icon.png`,
and the three Android adaptive-icon layers) was still the untouched
default Expo template artwork (a generic blue chevron logo, with the
icon-design grid guidelines literally still visible in the file) - never
customized since the project was first created.

Replaced with a crop of the game's own "Roster" menu icon (the glowing
yellow/blue neon cat symbol from the game's UI) - Raphael's reasoning:
players already recognize this glyph from the game itself, so it makes
the link to what the app actually does immediately clear, more so than
an original/unrelated design would.

How the crop was chosen: rather than eyeballing it, the neon cluster's
exact position in the source screenshot was measured programmatically
(color-thresholding to isolate the bright/saturated neon pixels from the
muted background, then picking the largest connected shape) to find its
true center, so the icon could be centered precisely on the cluster
rather than approximated by eye. Several rounds of feedback (framing,
then "move it down and about 10% right so it's centered") were checked
against a live rendered circular preview, including simulated small
sizes (192px/96px/48px, the sizes it's actually shown at), before
settling on the final crop.

What was generated:

- `assets/icon.png` - the plain square crop, opaque, no circular mask
  baked in. Used for iOS (which always applies its own rounded-square
  mask, ignoring whatever shape you give it - true circular icons aren't
  possible on iOS regardless of source art), the legacy/pre-adaptive
  Android icon, Expo Go's dev icon, and as the source for favicon.png
  and splash-icon.png.
- `assets/android-icon-foreground.png` - the same full-bleed square.
  Modern Android launchers apply their own mask on top (a circle on
  stock/Pixel Android, a squircle on many OEM skins) - since this is the
  exact crop already approved inside a circular preview, most common
  launchers will reproduce that same look without needing any special
  safe-zone padding baked into the file. Trade-off worth knowing: Google's
  official adaptive-icon guidance recommends a bit more margin than a
  plain inscribed-circle crop gives, for launchers with unusually
  aggressive mask shapes - left as-is here to preserve the exact framing
  Raphael approved, since this is a personal project rather than
  something going through Play Store review.
- `assets/android-icon-background.png` - a flat fill in the app's own
  dark theme color (`src/constants/theme.js`'s `darkColors.background`,
  `#121214`) rather than the original template's light blue. Rarely
  actually visible since the foreground above is fully opaque and fills
  the whole canvas, but ties the icon to the app's real dark-mode color
  on the rare launcher that reveals a sliver of it (icon-peek/parallax
  animations some OEM launchers do). `app.json`'s
  `android.adaptiveIcon.backgroundColor` was updated to the same color
  as a fallback.
- `assets/android-icon-monochrome.png` - for Android 13+'s opt-in
  "themed icons" setting, which needs a plain white silhouette on a
  transparent background (the OS applies its own tint). Derived from the
  same color-threshold detection used to find the crop's center, as a
  smoothed silhouette rather than a literal screenshot crop, since this
  layer has to be a clean alpha cutout to work at all. First attempt
  used too much blur to smooth the edges and ended up bridging the real
  gaps between shapes (between the ears, between the two cats) into one
  shapeless blob - fixed by using much lighter smoothing, which keeps
  real structure (the ear notch, the outlined cat's legs, the arrow)
  instead. This only affects users who've opted into themed icons in
  their phone's settings, so even an imperfect version here wouldn't
  have been a big deal, but it's cleaner now regardless.
- `assets/favicon.png` and `assets/splash-icon.png` - both updated to
  match too, for consistency. Neither is actually load-bearing for this
  app right now: there's no `expo-splash-screen` plugin installed and no
  `"splash"` key in `app.json`, so `splash-icon.png` isn't wired to
  anything (the app's real splash screen is the custom one built in
  App.js); `favicon.png` only matters if this app is ever run with
  `expo start --web`, which it hasn't been.

## Version control and GitHub

The whole project (not just `app/`) is now tracked with git, with its
first commit made. A few decisions worth recording:

- **The repo root is `/devikins-app/` (this folder), not `/devikins-app/app/`.**
  An earlier, narrower attempt only tracked the `app/` folder, which would
  have left this NOTES.md file and the research scripts/samples out of the
  repo entirely. Since nothing had been pushed anywhere yet, the repo was
  simply reinitialized at the right level rather than trying to preserve
  the narrower history.
- **A few things are deliberately excluded** (via `.gitignore` at the repo
  root): `node_modules/` and other regeneratable build output (standard
  for any JS project); `_to_delete/` (old pre-refactor backup files kept
  locally for reference, not meant for the project's public history); a
  `Claude outputs/` folder (this assistant's own delivered-file previews
  from along the way, like icon candidate images); and `app/.claude/`
  (this assistant's own local tooling config, not part of the app).
- **The original `LICENSE` file was removed.** It was the unedited
  default template from when the Expo project was first created, and
  incorrectly attributed copyright to "650 Industries, Inc. (aka Expo)"
  rather than Raphael. Caught and removed before the first push, rather
  than left in a public repo with the wrong author.
- **Commits are authored as `Raphael Rohner
  <36210810+RaphaelRohner@users.noreply.github.com>`** — GitHub's private
  "noreply" email format, so a real email address doesn't end up baked
  into public commit history.
- Just like installing packages (see "Development environment note"
  below), talking to github.com itself (creating the remote repository,
  authenticating, and the actual `git push`) has to happen from a real
  Terminal window on this Mac — the assistant's own sandbox can't reach
  github.com. `app/SETUP.md`'s "Sharing this project (and its APK) on
  GitHub" section has the exact steps.

- **Pushed and live**: the repo is now at
  `github.com/RaphaelRohner/devikins-legacy-companion`.

## Bug fixed: empty-state hint pointed the wrong direction

The very first screen (before any wallet is added) told players to "Tap
Wallets below" - true in an earlier layout, but the Fetch/Update/Wallets
buttons had since moved to the top of the screen, above that message, not
below it. Caught during real-device testing of the first APK build.
Changed the wording to "Tap Wallets above" to match the actual layout.

## Bug fixed: applied filters carried over between tabs

Switching tabs (Devikins -> Weapons, say) already closed the filter
panel and cleared the open detail view, but it didn't actually clear
the filter criteria itself - so a filter applied on one tab kept
narrowing the next tab's list too, silently, with the "Remove filters"
button still showing even though the panel looked closed. Since each
collection has its own set of traits, a filter picked for one doesn't
meaningfully carry over to another anyway. Fixed by clearing the
filter state (pending, applied, and active) in the same effect that
already resets the detail view and collapses the panel on a tab
change.

## App structure decisions (made while building)

- **No navigation library.** With just three tabs and no back-and-forth
  screen stack, plain React state (`useState` in `App.js`) decides which
  tab is showing. Adding a library like React Navigation would be more
  machinery than this app needs.
- **Filter controls are derived from the data, not hardcoded.** The filter
  panel asks the local database what values/ranges actually exist for the
  currently-loaded wallet and builds its dropdowns/range boxes from that,
  rather than a fixed list — so a wallet that only has 3 of 8 possible
  rarities only shows those 3 as options.
- **Numeric filter inputs use the default keyboard, not the numeric
  keypad**, specifically because iOS's numeric keypad has no minus sign,
  and Speed Modifier / Accuracy can both be negative.
- Full file-by-file breakdown lives in `app/ARCHITECTURE.md`; day-to-day
  run instructions live in `app/SETUP.md`.

## Development environment note

Built via Claude in a cloud sandbox linked to this Mac. That sandbox's shell
cannot reach the internet at all (confirmed: it can't even reach npm's
package registry), so anything requiring package downloads (creating the
Expo project, installing libraries) has to be run in a real Terminal window
on this Mac, not through the assistant's own tools. Everyday file edits,
by contrast, work fine either way.

While building, a self-check run of `npx expo export` (a full production-
style build, tried inside the sandbox with no phone involved) got through
bundling all 632 of the app's files with no errors, but then failed in a
separate native tool (`hermesc`) that only that specific build command
uses, with a shell-level error rather than a JavaScript one. That looks
like a sandbox-environment quirk with that one pre-built binary, not a
real bug — the actual test of the app is `npx expo start` + Expo Go on a
phone, which is a different, lighter-weight process and is what SETUP.md
walks through.

## Project structure

- `/devikins-app/` (this folder) — research scripts and this documentation.
- `/devikins-app/app/` — the actual Expo app lives here, kept separate from
  the research files above so the two don't get tangled together.
- `/devikins-app/app/SETUP.md` — how to install and run the app, plus fixes
  for common problems.
- `/devikins-app/app/ARCHITECTURE.md` — plain-English tour of what each file
  does.
