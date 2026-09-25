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

## Devi's FAQ is documentation too - keep it in sync

Whenever a user-facing feature gets added or changed, add/update an entry
in Devi's `FAQ_ENTRIES` (`app/src/components/HelpAssistant.js`) as part of
that same change - not as an afterthought, and not just NOTES.md /
ARCHITECTURE.md / TESTING.md. Devi is the in-app help section actual
players will read, so per feedback it needs to stay a complete, accurate
tour of everything the app does, not lag behind it. In practice: a new
entry (question + keywords + a plain-English answer, matching the existing
tone) for anything a user could plausibly ask "how do I..." or "what does
... do" about, and a correction to any existing entry a change makes
stale - this has already happened once, when the auto-retry removal left
two old Devi answers describing a background retry that no longer exists.

## Bump app.json's version when a real batch of changes lands

`app.json`'s `version` field (also mirrored in `package.json`) is the
one source of truth for the version shown on the splash screen and
sent in Feedback.js's email subject (see App.js's `APP_VERSION`) - it
does NOT bump itself, and per feedback it sat at the original "1.0.0"
through this entire V2 round of changes (hamburger menu, search/star
filter, list/tiles, names & ratings, feedback form, and everything
since) before anyone noticed. Bumped to "2.0.0" to match, since NOTES.md
already calls this whole body of work "V2" throughout.

Going forward: bump this whenever a meaningful batch of user-facing
changes lands, not necessarily on every single commit (this is a
personal, solo-tested app, not a public release train) - but don't let
it go stale for an entire round of feature work again either. A good
rule of thumb: if it's worth its own NOTES.md section, it's worth
considering for a version bump too.

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

**V2 addendum:** the new `custom_name` and `star_rating` columns (see
"V2: hamburger menu, search & star filter, list/tiles view, NFT names &
ratings, feedback form" below) are NOT treated the same way - they DO
persist across a re-fetch. The reasoning above is specifically about
what "Deleted" means (proof of continued ownership), which has nothing
to do with a nickname or a star rating, so there's no equivalent reason
to reset those two. `upsertNft` in `database.js` reads and re-applies
`custom_name`/`star_rating` on every write, but still deliberately
leaves `deleted`/`comment` out of that - see its own code comment.

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

## Icon crop widened for more padding

Feedback after the first APK install: the crop was a bit tight - the
yellow cat's ear tip and the arrow's point were right at the edge of
the circular mask. Widened the crop by 20% around the exact same
center (measured previously - see "Real app icon" above), so the same
neon cluster now has visible breathing room on every side instead of
touching the edge.

This meant regenerating all six icon files from scratch, not just
resizing the old ones, since the monochrome silhouette in particular is
derived pixel-by-pixel from the source screenshot. Re-running the same
color-threshold approach at this wider crop initially bridged gaps shut
again (the same failure mode as the very first monochrome attempt) -
because a wider crop means less magnification, so the neon outlines end
up relatively thinner in the resized 1024px image, and the same amount
of edge-smoothing that worked fine before now blurs adjacent lines into
each other. Fixed by smoothing through the resize itself (a high-quality
resize instead of a nearest-neighbor one, so edges come out anti-aliased
without needing a separate blur pass afterward) and cleaning up the
result by keeping only its real connected shapes (the main cluster, plus
the arrowhead tip that the color threshold treats as a separate piece)
rather than blurring everything, which discards small unrelated bright
specks (background/window reflections) without softening real structure.

## V1.0 - considered done

After a first standalone APK build and a full round of real-device
testing turned up four small bugs (all fixed and reflected in the
sections above: the empty-state hint text, filters carrying over
between tabs, the Stop button, and the icon crop), a second build
confirmed all four fixes plus the wider icon crop working correctly.
Raphael's call: this is a solid V1.0 - everything in TESTING.md's full
pass has been run against a real installed build, not just Expo Go.
Ideas for anything further (a hamburger menu, and whatever else comes
up) belong in a V2 rather than blocking this one - see `V2-IDEAS.md`
in this folder. Kept as a local-only file (listed in `.gitignore`,
never committed) rather than part of the repo, since Raphael would
rather it not show up on GitHub - the original, fuller copy still
lives in the project's claude.ai docs.

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

## Bug fixed: "Stop" during a fetch looked like it did nothing

Tapping Stop while a fetch was running correctly set a flag telling the
fetch loop to stop, and that flag WAS being checked before starting each
new NFT - but it was never checked (or acted on) while an NFT already in
progress was mid-request. Since a single NFT lookup can take up to about
a minute in the worst case (5 attempts, each with a 10-second timeout,
plus waits of 1s/2s/4s/8s between them - see metadataApi.js), tapping
Stop while one of the 4 concurrently-running lookups happened to be deep
in that retry sequence meant nothing visibly happened for up to a
minute, which reads as completely broken even though it would eventually
have stopped.

Fixed two ways together:

- `fetchNftMetadata` now accepts the same `shouldCancel` function the
  rest of the fetch pipeline already uses, and actually aborts its
  in-flight network request (via the same AbortController already used
  for the 10-second timeout) within about 100ms of a cancel, instead of
  only checking between whole NFTs. The pause between retry attempts is
  also cut short the same way, instead of always waiting out the full
  backoff delay.
- The Stop button itself now shows "Stopping..." and disables itself the
  moment it's tapped, rather than giving no visible acknowledgement at
  all while the (now much shorter, but not always instant) actual stop
  is in progress.

An NFT interrupted mid-request this way isn't saved as failed - it's
simply left alone, so it's picked up fresh on the next Fetch/Update or
automatic retry, same as if it had never been attempted.

## V2: hamburger menu, search & star filter, list/tiles view, NFT names & ratings, feedback form

A big batch of changes, all requested together as "V2":

### Navigation redesign: hamburger menu

The always-visible Fetch/Update and Wallets buttons, and the Devikins/
Weapons/Equipment tab row, are gone. In their place:

- A persistent search bar at the very top of the screen (search by NFT
  name, your own custom name for it, or its ID/nonce), with an exact-
  match 1-5 star filter next to it - tapping a star shows *only* items
  rated exactly that many stars (not "N or better"). Both carry over as
  you switch between Devikins/Weapons/Equipment, on purpose - see
  CollectionView.js's own comment on why trait filters reset per-tab but
  these two don't.
- A ☰ button underneath opens a full-screen menu (`HamburgerMenu.js`)
  with six entries: **Wallets** (shows how many are saved), **Fetch/
  Update** (an action - closes the menu and starts a scan without
  changing what's showing), **Devikins**, **Weapons**, **Equipment**,
  and the new **Feedback** (see below). The entry matching whatever's
  currently showing is outlined.
- The fresh-install hint text on the home screen was updated to point at
  the menu ("First add a wallet, then scan the chain: tap the ☰ menu
  below...") instead of the old buttons that no longer exist.
- `App.js` now tracks a single `currentScreen` value (one of the three
  collection kinds, `'wallets'`, or `'feedback'`) instead of the old
  separate `activeKind` + `showWalletManager` flags, plus a
  `lastCollectionScreen` so Wallets/Feedback's "‹ Back to Home" (and
  Android's system Back button) return to whichever tab you were on,
  not always Devikins.
- `TabBar.js` is no longer used anywhere, but left in the repo rather
  than deleted, in case the old tab-row look is ever wanted back.

### List / Tiles view

Each of the three collection screens now has its own **List/Tiles**
toggle, independent of the others (Devikins can be in Tiles while
Weapons stays in List). Tiles mode (`NftTile.js`) shows a dense 3-column
grid of just each item's picture and ID - meant for quickly scanning a
large collection by eye. The choice is remembered per collection across
app restarts, using the same generic `settings` key/value table
`getSetting`/`setSetting` already provided (previously unused for
anything load-bearing).

One React Native quirk worth knowing if you touch this code: you can't
change a `FlatList`'s `numColumns` on an already-mounted list - it
throws an error telling you to change the list's `key` instead to force
a fresh remount. `CollectionView.js`'s FlatList is `key={viewMode}` for
exactly this reason.

### NFT name & star rating

Every NFT's detail view now has a **Name & Rating** section, positioned
right after its stats and right before the existing Notes/Delete
section (per how this was requested):

- A **Name** field lets you give any individual NFT your own nickname,
  saved to a new `custom_name` column - separate from `name`, which is
  the in-game name pulled from the fetched metadata and never hand-
  edited. Saves automatically when you tap away from the field (no
  separate Save button needed for a plain rename).
- A **Rating** control (five tappable stars, `StarRating.js`) lets you
  give any NFT a 1-5 star rating, saved to a new `star_rating` column.
  Saves the instant you tap a star; tapping the same star again clears
  it back to unrated.
- Both are searchable from the top search bar and filterable via the
  top bar's exact-match star picker - see "Navigation redesign" above.
- `StarRating.js` is shared between that top-bar filter and this rating
  control via a `mode` prop (`"exact"` vs. `"cumulative"`) - see its own
  file comment for exactly how those two differ visually and why.
- **Found and fixed a real bug while adding these two columns:**
  `upsertNft` in `database.js` writes a full replacement row on every
  fetch (`INSERT OR REPLACE`), and any column not explicitly listed in
  that statement silently resets to blank - which would have meant
  every custom name and star rating got wiped the moment you next
  tapped Fetch/Update. Fixed by reading and re-applying both columns'
  current values on every write. This fix deliberately does NOT extend
  to `deleted`/`comment` (see "Multiple wallets, and marking NFTs as
  deleted" above) - that pair resetting on a successful re-fetch is
  separately documented as intentional, and this V2 work didn't touch
  that decision.

### Feedback form

A sixth hamburger menu entry, `Feedback.js`: pick a category (Feature
request / Bug report / Feedback) from a dropdown - the same `Picker`
pattern `FilterPanel.js` uses elsewhere, swapped in from an earlier row
of three buttons - optionally give a name, write a message, and tap
**Open Email Draft**. This builds a `mailto:` link
(app name, version, category, name, and the message all pre-filled into
the subject/body) and hands it to your phone's own email app via React
Native's `Linking.openURL()` - you still have to tap Send yourself once
it opens, since this app has no backend or email-sending service of its
own.

It goes to a "+" alias of Raphael's own Gmail address (mail to it
lands in his normal inbox, Gmail just treats everything before the
"+" as the real address), which makes it easy to filter/label
feedback separately without needing any new infrastructure. (The
actual address isn't spelled out here since this file is in the
public repo - see the "Feedback address changed" entry further down
for why, and what it was replaced with.) This was chosen over the original idea of routing
through a GitHub address after confirming (via GitHub's own docs)
that GitHub's commit-attribution noreply addresses are outbound-only -
they can't receive or forward inbound email from anyone, so "email
GitHub and have it land in my inbox" was never actually possible.

## Bug fixed: Android's Back button quit the app from the home screen

Pressing the system Back button/gesture while at the very top level (a
collection screen's list view, no NFT detail view open, hamburger menu
closed) used to exit the app immediately - a single accidental tap
(especially easy now that Wallets/Feedback/Devi all live one extra tap
"deeper" inside the hamburger menu than before) would close the whole
app with no warning.

Fixed with the standard Android pattern: the first Back press at that
point now shows a brief "Press back again to exit" toast instead of
exiting, and only a second Back press within 2 seconds actually quits.
Lives in `App.js`'s existing `BackHandler` listener - see its own
updated file comment for exactly where in the four-step priority order
(menu → Wallets/Feedback/Devi → NFT detail view → this) it sits.

## "Devi" - an offline, in-app helper (a joke that turned into a small real feature)

Asked, half-joking, for "a downgraded version of you" inside the app.
The honest, buildable version of that request is `HelpAssistant.js` -
an offline FAQ-style helper, not a real AI:

- It's the seventh hamburger menu entry ("Ask Devi").
- It answers by matching whatever you type against a small, fixed list
  of question/keyword/answer entries about using THIS app (adding a
  wallet, Fetch/Update, filters, List/Tiles, naming/rating an NFT,
  feedback, the Deleted behavior, resetting data) - plain keyword
  matching, nothing more.
- There's no language model, no network call, no API key, and no cost -
  a real AI chat (calling an actual LLM like Claude) would need a
  backend server to hold the API key safely (an app can't safely ship
  with its own API key baked in) and would cost real money per message,
  which is a much bigger project than anything else in this app.
- It says exactly what it is, right in its own greeting message and
  again whenever it can't match a question - it should never come
  across as smarter or more capable than a small fixed lookup table
  actually is.
- Every FAQ question and its answer are listed directly underneath one
  another, always visible in the same screen (not hidden behind chips
  you have to tap one at a time) - you can still type your own question
  in the box at the bottom instead, if none of the listed ones fit.

If you ever DO want the real thing (an actual AI chat inside the app),
that's a genuinely different, bigger project - it needs a small backend
service to hold an API key and proxy requests, plus a plan for who pays
for the API usage. Worth its own conversation when/if you want to go
there; it wasn't in scope for "downgraded".

## Back buttons shortened to just "‹" (an arrow, not "‹ Back to Home")

`WalletManager.js`, `CollectionView.js` (NFT detail view), `Feedback.js`,
and `HelpAssistant.js` each have their own top-left back button that
returns to whichever collection screen you came from. All four used to
say "‹ Back to Home" in full (`CollectionView.js`'s was even briefly
stretched edge-to-edge with that label, per even earlier feedback - see
that file's own style comment); per later feedback, all four were
shortened to just the "‹" arrow on its own, in a small round icon button
(40x40, fully rounded) instead of a text pill/edge-to-edge button. Same
`onPress` behavior as before in every case - only the button's look
changed.

## Automatic background retry removed - fetching is manual-only now

The background auto-retry timer described above (see "Automatic retry
timer (background)" and "Retry banner now says which kind of retry is
happening") has been removed from `App.js` entirely, per feedback that
nothing should happen over the network unless Fetch/Update is actually
tapped - a surprise background request wasn't worth the convenience of
not having to tap Fetch/Update by hand again.

Removed: the once-a-minute timer itself, its fast/slow pacing logic and
constants, the `isRetrying`/`retryProgress` state, and the banner it used
to show. `retryPendingItems`/`retryPendingItemsForWallets` (in
`app/src/api/fetchAllForWallet.js`) and `countPendingRetries` (in
`app/src/db/database.js`) are left in place, just unused for now, in
case a manual "retry failed items" button is ever wanted later - they
were already written to work from either an automatic timer or a manual
tap, so no code needed to change there, only `App.js`'s own timer that
called them.

**Reinstated later - see "Automatic background retry + image-freshness
check, reinstated" further down.** The concern that led to removing it
(nothing should happen over the network unless Fetch/Update is tapped)
turned out to matter less than it seemed once the fetch progress
display itself became a slim, glanceable row instead of a prominent
full-width banner (see "Trying the fetch progress bar inline" and its
follow-up) - with that fixed, quiet background checking stopped feeling
like a surprise.

## Back buttons shortened to just "‹" (an arrow, not "‹ Back to Home")

`WalletManager.js`, `CollectionView.js` (NFT detail view), `Feedback.js`,
and `HelpAssistant.js` each have their own top-left back button that
returns to whichever collection screen you came from. All four used to
say "‹ Back to Home" in full (`CollectionView.js`'s was even briefly
stretched edge-to-edge with that label, per even earlier feedback - see
that file's own style comment); per later feedback, all four were
shortened to just the "‹" arrow on its own, in a small round icon button
(40x40, fully rounded) instead of a text pill/edge-to-edge button. Same
`onPress` behavior as before in every case - only the button's look
changed.

## Star filter moved into Filters; theme toggle took its old spot

The exact-match 1-5 star filter used to sit in the persistent top bar,
next to the search field. Per feedback, it's moved down into each
collection's own **Filters** panel (`FilterPanel.js`) instead, as a
"Rating" row right at the top, above the data-derived trait filters -
visually grouped with the other filters, since that's conceptually what
it is, even though (like the search field) it still takes effect
immediately rather than waiting for "Apply Filters". The light/dark
theme toggle moved up into the spot the star filter used to occupy, in
the top bar next to search.

The underlying `starFilter` state (and the fact that it, like
`searchText`, deliberately survives switching between Devikins/Weapons/
Equipment) is unchanged - it still lives in `App.js` - only where the
control for it is DRAWN moved. See `FilterPanel.js`'s and
`CollectionView.js`'s own file comments.

## List/Tiles is now one shared choice, not per-collection

The List/Tiles toggle used to remember a separate choice for each of
Devikins/Weapons/Equipment (picking Tiles for Devikins wouldn't affect
Weapons). Per feedback that this was more confusing than useful, it's
now a single shared choice: picking Tiles on any tab shows Tiles on all
three. Turned out to be a smaller fix than expected - `CollectionView.js`
is the same mounted component instance the whole time you're switching
tabs (`App.js` just changes its `kind` prop), so the in-memory state was
already shared; the only bug was that it re-loaded a per-collection
value from the database every time `kind` changed, overwriting that
shared value right back into three separate ones. Fixed by storing it
under one shared settings key instead of `viewMode_${kind}`, and only
loading it once on mount rather than on every `kind` change.

## NFT nickname now needs an explicit "Save Name" tap

The nickname field in Name & Rating used to save itself the moment you
left the field (`onEndEditing`), with no separate button - reasoned at
the time as "a plain rename doesn't carry the same weight as marking
something deleted, so it doesn't need its own button." Per feedback,
that was changed: a **Save Name** button now sits right below the field,
greyed out/disabled whenever the typed text matches what's already
saved, and is the only thing that actually writes to the database now -
simply typing or tapping away no longer saves anything on its own. The
star rating above it is unchanged (still saves the instant a star is
tapped - picking a rating IS the action, there's no draft to separately
commit).

## Asked to make Devi "actually AI" - stayed offline on purpose

Later asked to make Devi a real AI instead of "more an FAQ". Same
tradeoff as when Devi was first built (see its own section above): a
real AI chat needs its own API key from a provider (Anthropic, OpenAI,
etc.), a small backend service to hold that key safely (an app can't
ship with its own key baked in), and would cost real money per message
on whoever's account the key belongs to - a genuinely different, bigger
project than anything else in this app, not something to build silently
as a small tweak.

Given the choice between building that (real cost/infra, needs a
provider + key decision first) or making the existing offline FAQ
smarter instead, chose the free/offline option:

- Matching (`matchEntry`/`scoreEntry` in `HelpAssistant.js`) went from
  plain "does this exact keyword substring appear" to something a bit
  more forgiving: typed text is normalized (lowercased, punctuation
  stripped) and split into words, and a single-word keyword now also
  matches a close typo or a plain prefix of it (via a small
  hand-written `editDistance`/Levenshtein function), not just an exact
  substring - so "walet", "wallting", or "automaticaly" still find the
  right answer. Multi-word keywords (like "star filter") still need to
  appear as a substring, same as before - fuzzy-matching a whole phrase
  wasn't worth the added complexity for this small a FAQ.
- Added three new entries that were missing given other recent changes:
  whether retrying still happens automatically (it doesn't any more -
  see above), where the light/dark toggle moved to, and whether more
  than one wallet is supported.
- Fixed two existing answers (Fetch/Update, and the Unavailable/Fetch
  failed one) that had gone stale by still describing the automatic
  background retry that was removed above - found while reviewing this
  file for the AI question, not something anyone reported directly.

If a real AI chat is ever wanted for real, that's its own conversation -
it needs a decision on which provider/API key to use and a small hosted
backend, before any app code changes.

## Top bar rearranged again: hamburger+theme on top, search+List/Tiles below

Continuing feedback on the top bar's layout (see the star-filter/theme-
toggle section above): the ☰ hamburger button now sits on its own row at
the very top of the screen, with the light/dark theme toggle on that
same row's right side (top-right corner) - both used to share a row
with the search field instead. Underneath that, the search field now
shares its row with the **List/Tiles** toggle on the right, which moved
up here from its own separate row inside `CollectionView.js`.

Moving List/Tiles required lifting its state up from `CollectionView.js`
into `App.js` (same pattern the star filter went through earlier):
`viewMode` and its `getSetting`/`setSetting` persistence now live in
`App.js`, which passes the current value down to `CollectionView.js` as
a plain `viewMode` prop - that file no longer owns this state itself,
just reads it. It's still one shared choice across Devikins/Weapons/
Equipment, same as before this move.

## Custom nicknames now show in the overview, not just the detail view

A nickname given via Name & Rating (see the V2 section above) used to
only be visible once you opened an NFT's detail view - the overview
list/tiles gave no hint anything had been named. Per feedback, named
items are now recognizable at a glance: `DevikinSummaryRow.js`,
`WeaponSummaryRow.js`, `EquipmentSummaryRow.js`, and `NftTile.js` all
now show `custom_name` (when set) as a small pill pinned to the item's
top-right corner - the row's corner in List view, the tile's corner in
Tiles view. Nothing shows at all for an NFT with no nickname given.

## Search field gets a clear ("✕") button

The top search field now shows a small "✕" overlaid on its right edge
whenever it has text in it, per feedback - tapping it clears the search
instantly instead of having to select and delete the typed text by
hand. Purely a `searchText === ''` check in `App.js`; the underlying
search behavior (and the List/Tiles toggle sharing this same row) is
unchanged.

## Feedback email body restructured to a fixed order

Per feedback, the `mailto:` draft's body now always follows one fixed
order:

```
App: Devikins Legacy Companion v1.x
Email: jane@example.com
Feedback type: Bug report
Name: (not provided)

Message:
<your typed message>
```

Two follow-up corrections after the first pass at this: the app
name/version moved back to the top of the body (it had briefly lived
only in the subject line - now it's in both places, since the subject
line is still handy for scanning an inbox); and the "Email:" line is
now a new optional form field for the sender's OWN email address, not
the fixed feedback address the draft is addressed to - the point of that line is giving Raphael a way to reply
to whoever sent the feedback, which the fixed address can't do since
it's always the same value. The draft's actual `mailto:` recipient is
unchanged; only what appears as body text changed.

## Star filter joined the Apply Filters flow, instead of applying instantly

Per feedback: the Rating row's star filter used to narrow the list the
instant you tapped a star - every other filter in the Filters panel
waited for an explicit **Apply Filters** tap. That inconsistency meant
tapping a star DID narrow the list right away, but the panel stayed
open on top of the (already narrowed) results, so in practice you still
had to tap "Hide filters" to actually see anything - with no Apply
Filters button ever showing up to explain why nothing else seemed to
be happening.

Fixed by folding the star pick into the exact same pending/Apply flow
the trait filters already use. `CollectionView.js` now tracks its own
`pendingStarFilter`, separate from the *applied* `starFilter` value
that still lives in `App.js` (so an applied rating keeps carrying over
between Devikins/Weapons/Equipment, same as before). Tapping a star
only updates the pending pick and makes Apply Filters appear, exactly
like changing a Rarity dropdown does; Apply pushes it up to `App.js`
via `onStarFilterChange`, Remove filters clears it back to 0, and
switching tabs with an unapplied pick drops it back to whatever's
still actually applied - never carrying an unapplied pick into another
tab. The underlying filter logic (still an exact rating match) and the
star highlighting (every star up to the pick lights up together, a
separate recent fix) are both unchanged - this was purely about when
the pick takes effect.

## Empty-filter message now names the collection and the applied filters

Per feedback: since the Devikins/Weapons/Equipment tabs moved inside the
hamburger menu, a bare "No NFTs match these filters." no longer made it
obvious which collection you were even looking at, or what was
narrowing it. The message now reads, for example:

```
No Weapons match the filters: Search: "flame", Rating: 4 stars,
Rarity: Rare, Scaling: 80 to 100
```

`CollectionView.js`'s new `describeActiveFilters()` builds that list -
search first, then the star Rating, then trait filters in the same
order `FilterPanel.js` shows them - reusing `FilterPanel.js`'s own
`humanizeColumnName` (now exported) so the wording always matches the
filter rows themselves. The Deleted switch isn't counted as a "filter"
here - excluding everything purely via Deleted still falls back to the
plain "this wallet doesn't hold any X yet" wording, same as before.

**Grammar fix, the same day:** the first version read "No Weapons NFTs
match the filter(s): ..." - flagged (by Raphael, a non-native speaker,
correctly) as reading wrong twice over: "Weapons" is a plural noun
awkwardly modifying "NFTs" (English attributive nouns are usually
singular - "car park", not "cars park"; "Devikins" gets away with it
because it reads as a proper/brand name, "Weapons"/"Equipment" don't),
and "filter(s)" is a written shorthand, not a real word. Dropped "NFTs"
entirely (matches the sibling "doesn't hold any Weapons yet" message's
own phrasing) and made "filter"/"filters" agree with how many are
actually listed.

## Explicit "Clear Rating" button, for un-rating a Devikin/Weapon/Equipment

The Rating control (`StarRating.js`) already let you un-rate something
by tapping the currently-lit star again (that toggle-to-0 behavior has
been there since the rating feature itself was added) - but per
feedback asking for "an option to un-rate", that gesture apparently
wasn't discoverable as an actual way to do it. Added a **Clear Rating**
button right below the stars in `NftCard.js`'s Name & Rating section,
shown only once `nft.star_rating` is actually set, calling the exact
same `handleStarRatingChange(0)` the repeat-tap already used - so both
ways to clear a rating do the identical thing, the button just makes it
visible as an explicit action. Since `nameAndRatingSection` is shared
across every detail layout (Devikins/Weapons/Equipment/the generic
fallback), this one change covers all three collections at once, same
as the earlier Save Name button did.

## Devikins' filters grouped into Genes/Affinities/Attributes

Per feedback: Devikins have 21 filterable traits, and the flat list in
Filters had gotten too long to scan comfortably. Regrouped it, exactly
per Raphael's own breakdown:

- Always visible, right below Rating: Rarity, Ancestry, Personality,
  Life Stage, Procreations Left.
- Three closed-by-default, tappable sections: **Genes** (Eyes/Mouth/
  Ears/Hair/Horns Gene), **Affinities** (Overall Affinity + the five
  element Affinities), **Attributes** (the five element Attributes).

The grouping lives in `DEVIKIN_FILTER_GROUPS` (`schema.js`) - a list of
`{ key, label, columns }` groups; any devikin trait NOT claimed by a
group defaults to always-visible, which happens to produce exactly
Raphael's requested five-item list (Rarity/Ancestry/Personality/
Life Stage/Procreations Left) simply because those are what's left
over in `TRAIT_COLUMNS.devikin`'s own declaration order once the
sixteen grouped traits are excluded - no separate "always visible"
list needed. `FilterPanel.js` looks the kind up in its own
`GROUPS_BY_KIND` map (currently `{ devikin: DEVIKIN_FILTER_GROUPS }`)
and falls back to the old flat list for any kind with no entry -
Weapons and Equipment aren't grouped yet, since Raphael's still
deciding whether that makes sense for them too. Which sections are
open (`expandedGroups`) is plain local `useState` inside
`FilterPanel.js` itself rather than lifted up to `CollectionView.js`
like the actual filter picks are - it's a display choice, not a filter
pick, so it's fine for it to reset to fully-collapsed every time the
whole panel is hidden and re-shown.

## Feedback address changed - primary email dropped from the app's source

The Feedback address (`FEEDBACK_EMAIL` in `Feedback.js`) was
a "+" alias of Raphael's own primary Gmail address - since the
feature was first built (see the
"Feedback form (V2)" section above for that original reasoning). It
worked exactly as designed: mail addressed to that alias landed
straight in his normal inbox, confirmed by an actual test send. But
per feedback, having his primary personal address sitting in the
app's source at all - even tagged with "+devikins" - wasn't something
he wanted, given the repo isn't guaranteed to stay just-for-him-only
forever.

Switched `FEEDBACK_EMAIL` to `chibitales2@gmail.com` instead - a
separate Gmail address Raphael already owns from an older game
project, unrelated to his primary identity. The mechanism is
completely unchanged (still a plain `mailto:` link, still no backend);
only the destination address changed. Updated `ARCHITECTURE.md` and
`TESTING.md` to match; left the original "+" alias explanation further
up in this file as-is, since it's accurate history of a decision that
was correct at the time, not a mistake to erase.

## Three bugs found testing the real APK build (v2.0.0)

All three were reported after installing the actual EAS-built APK on
Raphael's phone (rather than the Expo Go / dev-client test version),
and all three turned out to be things that only show up in a real
build, not in testing.

### Hamburger menu overlapped the status bar

`HamburgerMenu.js` renders its own full-screen `Modal`, separately from
the rest of the app's screens, which are all wrapped in
`SafeAreaView` (see `App.js`). A `Modal`'s content isn't automatically
kept clear of the status bar / notch / Dynamic Island the way
`SafeAreaView` content is, so the menu's fixed `paddingTop: 24` wasn't
enough on Raphael's phone - the "Menu" title and ✕ button sat partly
under the system UI. Fixed by reading `useSafeAreaInsets()` (the same
package already used elsewhere - see App.js's own insets comment) and
using `insets.top + 24` instead of a fixed number.

### Devi's typed-question answers looked like they weren't appearing

Asking Devi a free-text question in `HelpAssistant.js` was, and still
is, fully wired up (keyword matching against `FAQ_ENTRIES`, same as
the tap-a-suggested-question flow) - but the screen used to call
`scrollToEnd()` after every answer, and the chat bubbles share one
long `ScrollView` with the full always-visible FAQ list underneath
them. `scrollToEnd()` jumps to the bottom of *that whole list*, not to
the bottom of the chat bubbles, so your new answer appeared and was
immediately scrolled straight out of view, landing you on a wall of
static FAQ text that looked like nothing had happened. Replaced the
scroll-to-literal-end call with one that measures the chat bubbles'
own height and the visible viewport height, and scrolls only far
enough to bring the newest bubble into view at the bottom of the
screen - the way a normal chat screen behaves.

### Feedback's "Open Email Draft" button failed in the real build

`Feedback.js` checked `Linking.canOpenURL(mailtoUrl)` before opening
the device's email app, and only proceeded if that came back true.
That check worked fine in the Expo Go / dev-client test version but
returned false in the real build, with the app showing its own
"Couldn't open your email app" fallback message even though an email
app was installed. This is a known Android 11+ behavior: apps can't
see (query) whether another app can handle a link unless they declare
that ahead of time, and a plain Expo/EAS build doesn't declare it by
default - but actually *opening* the link isn't restricted the same
way. Fixed by dropping the `canOpenURL` pre-check and calling
`Linking.openURL()` directly inside the existing try/catch, which
still shows the same fallback message if opening genuinely fails (e.g.
no email app installed at all).

## Trying the fetch progress bar inline in the top row (experiment, not final)

Per feedback: the Fetch/Update progress display (`ProgressBar.js`) used
to render as its own full-width block below the top menuRow/searchRow
rows whenever a fetch was running - the concern being that it felt too
prominent and the app felt less responsive while it was up. First
thing tried, at Raphael's request: relocate the exact same component
to sit inline in `menuRow` itself, between the ☰ hamburger button and
the light/dark theme toggle, wrapped in a `flex: 1` View
(`inlineProgressWrapper`) so it fills whatever width is left between
those two buttons rather than overlapping either one. `ProgressBar.js`'s
own outer spacing (padding/margin) was trimmed slightly since it's no
longer a standalone block - App.js's wrapper handles spacing now.

Explicitly a first attempt, not a settled design - the component's
internal content (a status line, a progress track, and a Stop button)
was built for a full-width block, and squeezing that between two small
buttons may or may not read well on an actual phone. Comes from the
same conversation as reconsidering whether background retry checking
should ever come back - see "Automatic background retry removed" above
for why it's off today, and that any future automatic check would need
to stay consistent with that (nothing happens over the network without
an explicit tap).

**Follow-up after testing on an actual phone (same day):** the width
adjusted correctly, but the element was visibly taller than the
hamburger button/theme toggle either side of it, since its content was
still the original full-width design (a status line, then a progress
track below it, then a Stop button below that). Per feedback -
matching the row's height mattered more than showing full detail,
"just so users can see something is going on" - `ProgressBar.js` was
rebuilt as a single slim row fixed to the same 44px height as the
hamburger button: a thin fill track + percent number while a specific
collection is being fetched, or a plain spinner during phases with no
known total (listing/summary/error). The full status text (which
collection, exact counts, or the exact error) is still built
internally exactly as before - it's just not shown directly anymore.
Tapping the bar (anywhere except the ✕) shows it via a plain Alert, so
nothing that used to be visible is actually gone, it's one tap further
away instead. Background/border now match the hamburger button and
theme toggle (`colors.surfaceAlt`/`colors.border`) instead of the
earlier distinct blue-tinted block, so it reads as a third control in
the same row rather than a separate banner.

## Automatic background retry + image-freshness check, reinstated

Per feedback, once the inline progress bar (see the two entries above)
made a running fetch/retry unobtrusive rather than a prominent banner,
the original objection to background network activity mattered less -
so the automatic background retry timer removed in "Automatic
background retry removed" above is back, restored close to its
original design (same `AUTO_RETRY_INTERVAL_MS`/`MAX_AUTO_RETRY_ROUNDS`/
`SLOW_RETRY_INTERVAL_MS` constants and fast-then-slow pacing:
once-a-minute for up to 10 rounds after anything needs it, backing off
to once-an-hour after that, resetting to the fast pace on every manual
Fetch/Update), plus one genuinely new piece alongside it.

**New: a periodic image-freshness check.** From an earlier discussion
about `imageStorage.js`'s "download once, trust forever" behavior -
Moonlabs could in principle fix a wrong NFT image, either at a new URL
(already handled automatically, since a different filename just means
a normal fresh download) or by replacing the file at the exact same
URL (previously undetectable). Confirmed against the actual image host
(`img.devikins.com`, S3/CloudFront-backed) that a plain HTTP HEAD
request - no image body transferred - returns a real content-hash
ETag, cheaply enough to check a whole wallet's cached images
periodically. `checkImageFreshnessForWallets` (in
`fetchAllForWallet.js`) does exactly that: HEAD each cached image,
compare its ETag against what's on record (`image_etag`, a new column
added via `ensureColumn`, same migration pattern as `local_image_path`
originally), and force a real re-download (`storeImage`'s new
`forceRedownload` option) only when they genuinely differ. An image
with no ETag on record yet (anything cached before this column
existed) gets today's ETag backfilled without assuming it changed, so
future checks have something to compare against, rather than either
permanently skipping it or wrongly treating it as "changed" the first time
it's ever checked.

Deliberately a SEPARATE concern from the pending-items retry, sharing
only the same once-a-minute timer tick and busy/UI state: the
freshness check runs on its own plain hourly cadence
(`nextFreshnessCheckAtRef`/`IMAGE_FRESHNESS_CHECK_INTERVAL_MS`),
independent of whatever pace the pending-items retry is currently at,
and does NOT get reset by a manual Fetch/Update the way the pending-
items retry does - a normal Fetch/Update doesn't re-verify an
already-cached image against the remote host at all (see
`storeImage`'s fast-path reuse), so there's no reason a manual fetch
should hurry the freshness check along.

**Also fixed while touching this code:** `upsertNft` used to set
`local_image_path` to whatever a given call provided, with no
"keep the old value if this call didn't produce a fresh one" fallback
- unlike `custom_name`/`star_rating`, which already had exactly that
protection. In practice this stayed hidden most of the time (see
`storeImage`'s own "already have a good copy" fast path), but a
metadata response that happened to come back without an image field,
or an image whose file extension changed between fetches, could
silently disconnect a perfectly good already-downloaded picture from
its database row. `local_image_path` and the new `image_etag` are now
each preserved independently the same way `custom_name`/`star_rating`
are, when a given `upsertNft` call doesn't have a fresh value for
them.

Both mechanisms only run while the app is actually open, same as
before - nothing here registers a real background task
(`expo-background-fetch`/`expo-task-manager`), which stays a separate,
bigger feature on the V2 ideas list if it's ever wanted.

## Collection name shown in the compact progress bar

Small follow-up to the height-matched redesign above: the compact bar
made the top row a consistent height, but per feedback it didn't make
it obvious when a fetch moved from one collection to the next - it
only ever showed a bare spinner or a percent number, with the actual
"Devikins"/"Weapons"/"Equipment" text hidden behind a tap. `ProgressBar.js`
now shows a short badge with the current collection's name right in
the compact bar itself (derived from the same `label` fetchAllForWallet.js
already sends, with any "(NFT refetch)"/"(image refetch)"/"(image
check)" suffix stripped off since there isn't room for it here and the
tap-to-reveal Alert already covers it). Nothing else about the compact
design changed - still 44px tall, still one tap away from the full
detail.

## Pending-items retry also fires on app open and returning to the foreground

Raphael asked whether the app should do something automatically when
it's opened with a wallet already saved, now that the background
retry/freshness-check timer (see above) has proven itself unobtrusive
in testing. Discussed the options directly rather than guessing:
running a full fetch (re-checking every NFT's changing stats) every
single time the app opens was ruled out - unlike the pending-items
retry or the freshness check, a full fetch re-checks EVERYTHING for
EVERY owned NFT regardless of whether anything's actually wrong, which
would mean hammering the already-flaky metadata Lambda every time the
app is opened, including many times in the same day.

What Raphael chose instead: keep it to the same lightweight
"catch up on problems" pass the background timer already does
(retrying only items that previously failed, or are missing a cached
image - see `retryPendingItemsForWallets`) - not a full re-fetch of
everything - but trigger that pass immediately when the app opens,
AND every time it comes back to the foreground (e.g. switching back
after checking something else), rather than only waiting for the
timer's own once-a-minute/once-an-hour pace.

Implementation: the pending-items retry logic (previously only living
inside the timer's interval callback) was pulled out into its own
`runPendingRetryPass` function inside the same `useEffect`, so the
once-a-minute timer, an immediate call on mount, and a new
`AppState.addEventListener('change', ...)` listener (React Native's
own API for foreground/background transitions) all share the exact
same logic rather than duplicating it. The check this runs
(`countPendingRetries`) is a cheap local database read, not a network
call, so triggering it often - including in quick succession if
someone bounces in and out of the app - costs nothing extra when
there's genuinely nothing to retry; it only escalates to real network
requests once there's something actually pending. The image-freshness
check stays exactly as it was - purely on its own hourly timer, not
tied to opening the app - since a corrected image is a rare, low-
urgency event, not something that needs catching up on the moment the
screen is looked at.

## Tablet support: scaling the existing layout, not a separate design

First item on the V3 list: the app already technically ran on an iPad
(`app.json` already had `ios.supportsTablet: true`), but nothing about
the layout actually adapted to a bigger screen - the Tiles grid was
hardcoded to exactly 3 tiles per row, and the detail view / List-mode
rows had no width limit, so on a tablet either would end up looking
wrong (oversized tiles stuck at 3-per-row, or a detail card/row
stretched edge-to-edge with its labels and values spread unnaturally
far apart across the extra width).

Discussed two ways to handle this: scale the existing phone layout
(more tiles per row, width limits on single-column content) versus a
genuinely different tablet layout (list and detail side by side, like
Mail/Settings on an iPad). Went with scaling the existing layout -
Raphael's call, lower risk, and the side-by-side approach would have
meant reworking how CollectionView.js's detail view navigates (it's
currently just "swap the list for the detail view, tap back to swap
back" - not built to show both at once).

New `src/constants/layout.js` holds the actual logic, kept deliberately
keyed off the measured window width (`useWindowDimensions`, which
updates live on rotation or an iPad's split-screen resizing) rather
than checking the OS or `Platform.isPad` - an Android tablet is just as
wide as an iPad, so "how much width is there right now" is the
relevant question, not which OS is running. Two things it does:

- **Tiles grid**: `getTileColumns(width)` picks 3/4/5/6 tiles per row
  depending on width (3 stays the phone value), and
  `getTileFlexBasisPercent(columns)` reuses the exact gap ratio the
  original hardcoded 3-column, 31%-wide design already had, just
  generalized to any column count, so tiles keep looking the same
  regardless of how many happen to fit in a row. `NftTile.js` now takes
  a `columns` prop (defaulting to 3) instead of a fixed width.
- **List rows and the detail view**: `getCenteredContentPadding(width)`
  stays at the normal 12px padding up to 700pt wide (every phone, so
  this is a no-op there), then grows past that so the content ends up
  centered with a comfortable max width instead of stretching -
  applied once, to `CollectionView.js`'s FlatList/ScrollView
  `contentContainerStyle`, rather than editing every row/card component
  individually (each already has its own `marginHorizontal: 12`, which
  still applies inside that now-narrower box).

Not touched: the top menuRow/searchRow bars, the filter panel's own
dropdowns, and the various modal screens (WalletManager, Feedback,
HelpAssistant) - their controls just end up a bit more spread out via
their existing `space-between` layouts on a wide screen rather than
looking actually broken, so left alone for now rather than expanding
scope beyond what was actually asked for. Worth revisiting once this
has been tried on a real tablet.

## QR code scanner for adding a wallet

Second item on the V3 list: a camera button next to the "Add a wallet"
field on the Wallets screen, so a wallet address can be scanned from
its QR code instead of always having to type or paste it. Installed
`expo-camera` via `npx expo install` (matches it to this project's
Expo SDK 57 automatically) - it's one of the core Expo SDK modules
Expo Go itself already supports, so this works with the same
`npx expo start` + Expo Go workflow the rest of the app is tested with,
no custom/"dev client" build needed.

New `QrScannerModal.js` is a full-screen camera overlay: requests
camera permission via `useCameraPermissions()`, shows a plain message
(plus a request button, or an "enable it in Settings" message if it
was already denied and can't be asked again) if permission isn't
granted, and otherwise shows the live camera feed via `CameraView`,
watching for a QR code via `onBarcodeScanned`. That callback fires on
every camera frame a code is still visible in, not just once, so it's
guarded to only act on the first one per time the scanner is opened.

**Deliberately doesn't add the scanned wallet directly** - it only
fills the exact same text field a manual paste would
(`WalletManager.js`'s `handleScanned`), then closes back to the normal
Wallets screen, so the actual Add button - and everything that already
happens when it's tapped (the "first wallet ever" heads-up, etc.) -
runs completely unchanged either way the address got into that field.
This also means a scan stays visible and editable before anything is
actually added.

**Tried against a real scan (Sep 2026):** Raphael scanned his own
Klever wallet app's actual QR code and it correctly filled in the
right address. What wasn't confirmed is WHICH of `extractAddress()`'s
two paths actually handled it - whether the QR just encodes the plain
`klv1...` address as-is, or something wrapped that the regex fallback
successfully pulled an address back out of - since the raw, pre-
extraction scanned text was never inspected. Either way the visible
result was correct, so this isn't blocking anything, but it does mean
a QR format the regex fallback DOESN'T handle (no `klv1...` pattern
anywhere in the scanned text at all) is still an open possibility with
some other wallet app or QR source, not something actually ruled out
by this one successful test. Filed as
[GitHub issue #1](https://github.com/RaphaelRohner/devikins-legacy-companion/issues/1)
to track, since it only fills the Add field rather than adding a
wallet directly (see above), so the worst case is a scan that doesn't
work as expected, not silent data corruption.

## Sort button, next to List/Tiles

Discussed before writing any code: Raphael's first idea was a new
hamburger-menu entry with its own subpage, modeled on SQL's multi-column
`ORDER BY`. Went with something smaller instead, for two reasons. First,
a full multi-field sort (rarity, then level, then ID, ...) is a lot of
UI for a benefit that's mostly covered already by the per-collection
filters - the filters narrow the list down, sorting just decides what
order the narrowed list reads in, which is usually driven by one thing
at a time ("show me my rarest first", "show me by level"). Second, a
single sortable field still needed a tiebreaker to be useful - sorting
100 Devikins by Rarity alone, with dozens tied at "Common", would leave
those ties in a meaningless, effectively random order.

Landed on: a compact Sort button next to the existing List/Tiles toggle
(searchRow in App.js), opening a small bottom-sheet picker
(SortPickerModal.js) rather than a full subpage - the whole choice is
"which field, which direction", which doesn't need a screen of its own.
Tapping a field that isn't already active picks it, at a sensible
starting direction (descending for stats, ascending for ID); tapping the
ACTIVE field again flips its direction instead - one tap either sets or
flips, never a separate control for direction. The tiebreaker is
automatic and free: `queryNfts()` in database.js always asks SQLite for
`ORDER BY nonce ASC` first, and JS's `Array.prototype.sort()` is
guaranteed stable (ES2019+), so sorting that already-ID-ordered array by
whatever field was picked leaves ties in ID order without any extra
code. Rarity sorts by game order (Common → Eldritch, via the existing
`RARITY_ORDER` list), not alphabetically; missing values always sort to
the end regardless of direction, so an unset stat doesn't jump to the
top on a descending sort.

Per feedback, the field list offered is whatever `getSortableFieldNames()`
(schema.js) says is sortable for the CURRENT collection - ID and
"Recently Added" (see next section) everywhere, plus each collection's
own real stat columns (the same ones the Filters panel already treats as
user-facing, via `filterable !== false` - bookkeeping fields like
`icon_image` are excluded the same way there too). Switching tabs keeps
the current sort if the new tab also has that field (e.g. Rarity exists
on all three), and quietly resets to ID/ascending if it doesn't (e.g.
leaving a Weapon-only stat behind when switching to Devikins) - handled
by a small effect in App.js that re-checks the active field whenever
`currentScreen` changes.

The search field visibly got a bit narrower to make room for this
button, which was raised and accepted as a fair tradeoff before building.

## "Recently Added" sorting, via a new `first_seen` column

A byproduct of the sort discussion: Raphael pointed out that knowing
when an NFT first showed up in the app would be useful on its own,
letting the sort button offer "Recently Added" as a field even though
it isn't one of the game's own stats. Added a `first_seen` column
(INTEGER, epoch ms) to each collection table, set once and never
overwritten: `upsertNft()` in database.js now reads any existing row's
`first_seen` before writing and reuses it (`existingUserData?.first_seen
?? Date.now()`), so a normal re-fetch of an already-known NFT doesn't
reset its "first seen" date just because the app happened to refetch it
again. Existing rows from before this column existed are backfilled once
at startup to their `fetched_at` value (the closest available stand-in,
since there's no way to know the real original date), inside
`initDatabase()`.

## Passive per-NFT change history (`nft_history` table)

Came out of the same conversation, from a different angle: Raphael's
"m2n table with NFT as ID, date and change" idea, motivated by wanting
to eventually answer questions like "how long did it take this weapon to
go from Common to Eldritch?" - something the filters and the sort button
above can't do, since both only ever look at the CURRENT value of a
stat, not its history.

The important decision, made before writing anything, was the table
shape. The obvious-looking alternative - a dedicated table (or columns)
per trait, e.g. tracking rarity changes and level changes separately -
would need a new one added by hand every time a new trait gets tracked
in `schema.js`, and wouldn't handle a trait no one anticipated. Instead,
one generic append-only table:

```
nft_history(id, kind, nonce, field_name, old_value, new_value, changed_at)
```

One row per detected change, to any tracked field, on any collection -
exactly the "NFT as ID, date, change" shape Raphael described. This is
what actually needed deciding NOW rather than later: once more features
start relying on a specific table shape, changing it gets harder, and
starting to log from today, in this shape, means any future
history/timeline viewer already has real data to show going back to
whenever this shipped - rather than only starting to collect data
whenever that later viewer actually gets built.

**Logging is passive and silent for now - there is no viewer UI yet.**
`upsertNft()` diffs each trait field's old value (read from the existing
row before overwriting it) against the new one on every fetch, and
inserts a history row for anything genuinely different. Two deliberate
safety rules, both driven by the metadata endpoint's already-documented
flakiness (see the image-caching/retry notes above) making a fetch
occasionally come back with a field missing or `null` that has a real
value the rest of the time:

- **A value disappearing (going to `null`/missing) is never logged as a
  change.** A real in-game trait doesn't un-set itself; a flaky partial
  response looking like one shouldn't get written into permanent
  history.
- **Comparisons use loose (`==`) equality**, not strict, so a value
  coming back as the SQLite-stored number `5` one time and the
  JSON-parsed string `"5"` another doesn't get logged as a "change" that
  never actually happened in-game.

Scoped to the same `filterable !== false` trait fields as the Filters
panel and the sort field list above - no bookkeeping columns, no
`icon_image`. Only fires when there's a previous row to compare against
(`existingUserData` exists) and the fetch succeeded (`status === 'ok'`),
so a brand-new NFT's first-ever fetch never logs "changes" against
nothing.

Known, accepted limits, worth remembering when a viewer for this
eventually gets built: history can't be backfilled retroactively - it
only starts from whenever this shipped, nothing earlier; it only
captures a change if a wallet holding that NFT is actually in the app
and gets fetched/refetched while the change is current (an NFT can
change and change back between two fetches with nothing logged, and
anything before this feature's first commit is invisible); and it's
necessarily per-NFT, not some global game timeline.

## Wallet sets: separate, named, switchable collections

The last piece before calling this version 3.0.0. Came out of a design
discussion about two candidate features - an undo for Reset All Data,
and named "wallet sets" - where the second turned out to make the first
unnecessary (if you can just create a fresh set and switch back to the
old one any time, there's nothing left for a reset-undo to do that sets
don't already cover), so only this one got built.

A wallet set is a completely independent copy of everything the app
tracks - its own wallets, its own fetched Devikin/Weapon/Equipment rows,
its own downloaded images - identified by a name (e.g. "My Wallets",
"Kiddo's account", "Friend's collection"). The point: a second player in
the household, or checking a friend's collection, or a wallet that
turned out to belong to a big contract and flooded the database with
broken entries, can each get their own space without mixing into - or
requiring a wipe of - anything else, and switching between them never
re-fetches anything, since nothing is actually shared or merged.

**Architecture: one database FILE per set, not one shared database with
a "which set" column on every row.** `database.js`'s `getDatabase()`
used to always open the same hardcoded `devikins.db` file; it now opens
whichever file `activeDatabaseFileName` currently names, and switching
sets is nothing more than closing that connection
(`closeActiveDatabase`) and opening a different one. Every existing
query function in that file - every filter, every sort, the breeding
helper, the compare view, all of it - keeps working completely
unchanged, since they all just call `getDatabase()` internally and have
no idea a "set" concept even exists. `imageStorage.js` got the same
treatment for its own image folder (`setActiveImagesDirName`). This was
chosen over tagging every row with a set id and filtering everywhere,
both because it's a much smaller change (nothing outside `database.js`
and `imageStorage.js` needed to know sets exist at all) and because it
fully isolates the data - if the same physical NFT nonce ever showed up
in two different sets (a trade or gift between the two wallets), keeping
them in genuinely separate files guarantees one set's notes/deleted-
flag/star-rating on that nonce can never bleed into the other's.

A second, always-open, never-swapped database (`wallet-sets-registry.db`,
via `getRegistryDatabase()`) tracks which sets exist and which one is
active - it has to live outside the per-set database, since that's
exactly the thing getting closed and reopened on every switch. It also
holds a small `global_settings` table for the one preference that should
survive a set switch instead of resetting with everything else -
List/Tiles view mode, moved here from the old per-set `settings` table
(via new `getGlobalSetting`/`setGlobalSetting`, App.js) specifically so
picking a different set doesn't also silently flip your view mode.

**Migration:** the very first time this runs on a phone that already had
data (i.e. everyone upgrading from v2), `initWalletSets()` finds the
registry empty and registers a set called "My Wallets" pointing at the
exact same filenames the app always used (`devikins.db` /
`nft-images/`) - zero data actually moved, copied, or renamed anywhere.
Same shape as the wallets-table migration this codebase already did
once before (see the multi-wallet section further up).

**The five actions Raphael asked for**, all in `WalletManager.js`'s new
switcher section at the top of the Wallets screen, above the existing
per-wallet Add/Edit/Delete list (which is always scoped to whichever set
is active):

- **Create** - names and immediately switches into a brand-new empty
  set. No separate "save" step; per Raphael's own call, creating +
  naming + fetching into it IS what keeps it saved, the same way adding
  a wallet doesn't need a separate save tap either.
- **Load** - tapping any set's name in the list switches to it.
- **Rename** - available on any set, the default "My Wallets" included,
  since (Raphael's own words) "it might not be his wallets he wants to
  check."
- **Empty** - unloads the active set without touching its data at all.
  Leaves the app with nothing active until Wallets is visited again to
  load or create one - a state the app already had to handle anyway
  (zero wallets/zero NFTs is exactly what a fresh install or a Reset
  already looks like), so no forced blocking screen was needed; Raphael
  explicitly confirmed an "empty app" is fine to allow.
- **Delete** - permanent, with the same style of destructive
  confirmation dialog Reset All Data already used. Works on any set in
  the list, not just the active one, so a set that turned out to be a
  mistake (Raphael's own example: loading a big contract address by
  accident and getting a pile of broken entries) can be cleared without
  first switching into it.

**Reset All Data got a quiet but important fix alongside this**: it used
to only ever touch whichever database happened to be open. With sets
now able to exist, that would have silently left every OTHER set's
database file and image folder sitting on the phone while claiming to
have wiped "every saved wallet and every stored NFT." It now loops over
every registered set, deletes each one's files, wipes the registry, and
recreates a single fresh "My Wallets" set - genuinely back to a
brand-new install, not just a reset of whichever set you happened to be
on.

Devi's (`HelpAssistant.js`) FAQ list got a new entry for how sets work,
and the existing "how do I reset all my data" entry now also mentions
each set's own Delete button as the gentler, narrower alternative.

Known, accepted edge case: switching/creating/deleting a set while a
fetch is actively in progress isn't specially guarded against. Worst
case, an in-flight fetch's next database write fails against a
connection that just got closed out from under it (a failed-fetch error,
not data corruption - SQLite commits each write as it happens, so
nothing already written is lost or mixed up). Low risk for a single-user
app where switching sets mid-fetch isn't something you'd do by accident,
so this wasn't specially engineered around - noted here in case it ever
needs revisiting.

## Kleverscan menu position, plus catching up Devi's FAQ

Two small follow-ups once V3 was basically done and about to be built:

- **Kleverscan moved up in the hamburger menu**, from last (after Ask
  Devi) to right after Breeding Helper, before Feedback. Reasoning:
  Wallets through Breeding Helper are all tools about your own
  collection; Feedback and Ask Devi are the two "about the app itself"
  entries. Kleverscan belongs with the first group, not tacked onto
  the end after the app-meta pair.
- **Devi's FAQ (`HelpAssistant.js`) got a pass to catch up with recent
  changes** - asked directly whether Devi had been kept in sync, and
  the honest answer was "partly": a new `kleverscan` entry was added
  (it had no answer at all before), `reset-data`'s answer was updated
  to mention flipping the Danger zone's toggle on before Reset All
  Data is reachable (a leftover from that feature landing after this
  answer was last written), and `automatic-retry` was fixed to
  actually describe the current behavior - it still flatly said "No,
  not any more, there's no automatic background retrying," which
  stopped being true once the pending-items retry timer was reinstated
  (see "Automatic background retry + image-freshness check,
  reinstated" above) and nobody had gone back to update this answer
  since. Good reminder that "Devi's FAQ is documentation too" (this
  file's own second section) needs an occasional audit pass, not just
  updates at the moment each feature ships.

## Wallet sets screen: two polish tweaks from real use

Two small adjustments Raphael asked for after actually using the
Wallets screen for a while - both quick, no architecture changes:

- **"+ New set" moved above the list of existing sets**, right under
  the explanation text, instead of below every set already listed.
  Starting a new set is the action you'd reach for most often, so it
  shouldn't require scrolling past however many sets already exist
  first.
- **Danger zone now sits behind its own toggle, off by default.** The
  "Danger zone" label and a Switch are always visible (same bordered-
  label-plus-native-Switch idea as the Deleted switch on the
  collection screens), but the actual explanation text and the Reset
  All Data button only show once that switch is flipped on. Wallets is
  a screen you open often - a screen-wiping button in view every
  single time was more prominent than it needed to be for something
  used rarely, but it's still easy to find on purpose, not buried
  somewhere else.

## Kleverscan tab: an in-app browser to Klever's block explorer

A ninth hamburger menu entry, "Kleverscan" - opens a real embedded
browser (not a hand-off to the phone's own browser app) pointed
straight at the Devikins collection's own asset page on
kleverscan.org, Klever's own block explorer - holder counts, supply,
and on-chain activity, without leaving the app or typing the asset ID
in by hand.

Built with `react-native-webview` (confirmed "Included in Expo Go" in
Expo's own docs before adding it, and installed via `npx expo install
react-native-webview` - no custom dev build needed, same bar every
other native module in this app was picked against). Deliberately not
`expo-web-browser`'s `openBrowserAsync`: that opens as a separate
system browser sheet layered on top of the app, not a real screen -
Raphael specifically asked for "a tab," so this instead reuses the
exact same full-screen-takeover pattern every other menu screen here
already uses (`KleverscanView.js`, rendered by `App.js` the same way
as WalletManager/Feedback/HelpAssistant/BreedingHelper), with its own
"‹" back button.

The target URL is built from `COLLECTIONS.devikin.assetId` in
`src/constants/schema.js` (the same real Klever asset ID,
`DVKNFT-1SW5`, the app's own API calls already use) rather than a
hand-typed string, so it can never quietly drift out of sync -
`https://kleverscan.org/asset/DVKNFT-1SW5`.

A small back/forward/reload row sits above the page itself. Without
it, tapping any link on Kleverscan (into a wallet address, a
transaction, the fungible DVK token, etc.) would strand you there with
no way back except leaving the tab entirely and losing your place.
`canGoBack`/`canGoForward` come straight from the WebView's own
`onNavigationStateChange` callback, so the buttons disable themselves
correctly instead of always looking tappable.

**Update (same week): opens on the Holders tab, not Overview.** Once
Raphael was actually using this, the ask was to land on Kleverscan's
Holders tab specifically - not one of the top-level asset tabs, but a
second row of sub-tabs (Transactions/Holders) below the stats.
Confirmed via the actual site (clicked Holders, read
`window.location.href` afterward, then re-loaded that URL fresh to
make sure it isn't just client-side tab state) that it's a plain query
param: `?tab=Holders`, and that it lands there correctly on a cold
page load too, not only after clicking the tab client-side. URL is now
`https://kleverscan.org/asset/DVKNFT-1SW5?tab=Holders`. Matches
something that came up organically once Raphael started using this
for real: someone who knows roughly how many Devikins they hold, but
not their own wallet address, can browse the Holders list to find
themselves - the Holders tab is the actually-useful one for that, not
Overview.

## Wallet set actions now surface real errors instead of failing silently

While investigating Raphael's report that after deleting a wallet set he
couldn't select another one, reading through the wallet-set code (and a
standalone simulation of the same delete-then-switch sequence against a
real SQLite database, outside the app) turned up no bug in the
create/switch/rename/empty/delete logic itself. Rather than keep
guessing, every wallet-set action in `WalletManager.js` (create, switch,
rename, empty, delete, and Reset All Data) is now wrapped so a failure
shows a real alert ("Something went wrong ... didn't complete: <the
actual error>") and logs to the console, instead of whatever went wrong
just silently doing nothing. Retrying afterward on a large set (lots of
NFTs and images) didn't reproduce the original issue, so this stays in
as a safety net for if it ever does happen again - next time, there
should be an actual error message to go on instead of a guess.

## Wallet sets screen: headlines clarify what belongs to the active set

Raphael pointed out that the Wallets screen's layout - "+ New set", the
existing sets, the Add-a-wallet row, and the wallet list - didn't make
it obvious that the last two (Add row and wallet list) belong
specifically to whichever set is currently active, not to wallet sets
in general. Asked which of two fixes he meant (add headlines, or
restructure so the Add/list only appear directly under the set you
tap); he confirmed headlines. Two small text changes, no layout
restructuring:

- The switcher section's title changed from "Wallet set" to "Wallet
  sets" (plural - it's the list of sets, not the active one).
- A new headline, `Wallets in "<active set name>"`, sits right above
  the Add row and the wallet list beneath it, naming the set they
  belong to by its actual name rather than leaving that implicit.

## V3.1 - three small corrections from real use

The first work toward V3.1 (version not bumped yet - two bigger features,
a real background scan and an NFT history view, are still to come before
this becomes an actual release; see the project's own v3-feature-ideas
doc for that discussion). Three small corrections raised after some real
day-to-day use of V3.0.0:

- **Wallets screen's top explanation was wrong since wallet sets shipped.**
  It still said "Fetch/Update pulls ... from every wallet address listed
  here," which reads as every wallet across every set - not true since
  wallet sets exist, each with its own separate wallets. Reworded to
  "from every wallet in your active wallet set below - not every wallet
  across every set." Devi's own `multiple-wallets` FAQ answer had the
  exact same stale claim ("Fetch/Update pulls ... from all of them
  together") - caught and corrected alongside it, per this project's
  standing rule to keep Devi's answers in sync with whatever changes.
- **The NFT count is a styled chip again, matching the theme toggle.**
  Back when the count/Compare-progress text first moved up into menuRow
  (next to the hamburger button and theme toggle), it lost the bordered
  "button" look it used to have further down the old toolbar and became
  plain centered text. Restored that look - now wrapped in a bordered
  chip (`menuRowStatusChip` in `App.js`) using the exact same
  border/background/radius/padding as the theme toggle right next to it,
  so the two read as a matched pair. Purely visual - it's still just a
  status display, not a new tappable control.
- **Devi's FAQ grouped into topics.** All 17 questions used to be one
  flat list - per feedback, unstructured once there were this many.
  Grouped under five headings (`FAQ_TOPICS` in `HelpAssistant.js`):
  Wallets & wallet sets, Browsing & organizing your collection, When
  something looks off, Other tools, and Data, feedback & about Devi.
  Purely a display grouping - each entry keeps its own `topic` field
  alongside its existing keywords, and the free-text matching logic
  still searches every entry regardless of topic, so this doesn't change
  what typing a question finds, only how the always-visible list reads.

## Devi: added Breeding Helper and Compare mode answers

Both shipped back in V3.0.0 (as part of the big toolbar-redesign/
Breeding Helper/Compare mode batch - see the "V3 backlog - Kleverscan
tab" and preceding sections) but never got a Devi FAQ entry, so Devi's
FAQ upkeep rule (see this file's very first section) had quietly lapsed
for these two. Added under the "Other tools" topic, alongside
Kleverscan: `breeding-helper` explains the two-step Rarity/Procreations
Left/Affinities flow and its one hard limit (no parent/lineage data
exists anywhere, so relatedness is still on the player); `compare-mode`
explains the ⇄ button, the two-item selection, and the "Show
differences only" toggle. Both keyword-matchable the same as every
other entry, in addition to showing in the always-visible grouped list.

## NFT count chip: height matched to the hamburger button, width to the search field

Follow-up on the previous "NFT count is a styled chip again" fix - it
looked right per feedback, but wasn't quite lining up with the hamburger
button/theme toggle in height, and stayed sized to its own text content
rather than the full width of the search field one row down. Switched
`menuRowStatusChip` (`App.js`) from copying themeToggle's padding
numbers to copying `ProgressBar.js`'s own `container` style instead -
the progress bar literally swaps into this exact same slot while a
fetch/retry is running, and its own style comment already says its
`height: 44` "matches the hamburger button's own height exactly," so
matching that (rather than trusting padding numbers to add up the same
way, which has bitten this app before - see sortButton's arrow-glyph
line-height comment) is what actually guarantees the row lines up.
Dropped the chip's own fixed alignSelf/maxWidth too, so like
ProgressBar - and like the search field in its own wrapper one row
down - it now fills its full flex:1 slot instead of hugging its own
text.

## NFT history gets a viewer: the "Changelog" button

The first bigger V3.1 feature (see "V3.1 - three small corrections from
real use" above for the smaller ones, and the project's own
v3-feature-ideas doc for the full V3.1 plan). The `nft_history` table
itself has existed since V3.0.0 ("Passive per-NFT change history" above)
and was already quietly logging every real trait change it caught on a
fetch - this is the first time any of that data is actually shown to a
player.

Raphael's own proposal, implemented close to as-described: a floating
"Changelog" button, bottom-right in an NFT's detail view, that only
appears once there's actually something logged for that item (an NFT
with no history shows no button - nothing to lead to an empty sheet).
Tapping it opens a bottom-sheet list (`NftHistoryModal.js`, reusing
`SortPickerModal.js`'s existing dim-backdrop/rounded-sheet pattern
rather than inventing a new one) of every logged change, newest first.

Two things worth remembering about how it reads the data, both handled
in `NftHistoryModal.js` rather than the database layer:

- **Grouping.** A single fetch can catch more than one real change at
  once (say Procreations Left and Life Stage both moved since the NFT
  was last seen) - `upsertNft` logs those as separate rows, but every
  row from the same fetch shares one `changed_at` timestamp (stamped
  once per fetch, not once per field). The viewer groups rows sharing
  that exact timestamp into a single dated entry, so a fetch that
  caught three changes reads as one entry listing all three, not three
  disconnected lines.
- **No fake/test data.** Building this without any real change ever
  having fired yet made testing awkward enough that a "fake a before
  value for debugging" shortcut was floated and then explicitly
  declined ("I agree with everything except the fake before entries.
  Don't need them.") - Raphael's own in-game wallet holds real Devikins/
  Weapons/Equipment he can fetch and refetch to generate genuine history
  for testing, so this stayed out entirely rather than shipping a debug
  path nobody wanted.

One real fix landed alongside the viewer, in `upsertNft` itself:
Weapons' `durability` is now excluded from being logged at all. It's
current wear state, not meaningful history - it changes constantly
during normal play, and logging every tick of it would flood a
weapon's Changelog with noise burying the traits someone would
actually want to see there (Rarity, Improvement Level, Refine XP, ...).
`base_durability` is deliberately NOT excluded alongside it - per the
same game knowledge, it shouldn't change at all, so if it ever does,
that's exactly the kind of unexpected thing worth a history entry, not
noise. Excluded at the point of writing (never logged in the first
place), not filtered out later in the viewer.

Devi's `changelog` FAQ entry (under "Browsing & organizing your
collection") was added alongside this, per the project's standing rule
to keep Devi in sync with whatever ships.

Background scan - the other bigger V3.1 feature - stays deliberately
next, not started here; see the project's own v3-feature-ideas doc for
why it got reprioritized behind this one.

## Changelog button moved from a floating pill to the header row

Follow-up the same day, after Raphael's first real test of the
Changelog feature above (weapon #1450: added a slot and bumped it from
Common to Uncommon in-game, then confirmed the app's own fetch caught
both changes correctly - `Slot: None -> Slotted`, `Rarity: Common ->
Uncommon`, grouped under one entry). The feature itself worked; the
floating bottom-right button was just easy to miss.

Raphael offered two alternatives - float it near the top under the
item's own ID, or move it up into the row the back button already
lives in. Went with the second: a new `detailHeaderRow` now holds both
the back button (left) and Changelog (right, when there's history to
show), the exact same row pattern `KleverscanView.js` already uses for
its own back-button-plus-controls row. Preferred over the "float near
the ID" option since that would mean guessing a pixel offset into
`NftCard.js`'s own layout, which differs between Devikins/Weapons/
Equipment and moves with the scroll - the header row is anchored to
something already identical and fixed across all three.

`historyButton` dropped its floating-pill styling (no more
`position: absolute`, no shadow/elevation) now that it's a plain
button sharing a row rather than something hovering over scrollable
content - and its height now matches the back button's own 40px
exactly, rather than the bigger 50px a truly standalone floating
button needed.

## App structure decisions (made while building)
 (made while building)

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
