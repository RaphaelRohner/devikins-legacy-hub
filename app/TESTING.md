# TESTING.md — How to test the Devikins Legacy Hub

There are two kinds of testing for the Hub:

1. **Automatic website tests** (below): checks a computer runs on the
   website version in a few minutes, with one command - and GitHub runs
   them on every push. They cover the parts that are easy to break
   without noticing: fetching, pictures, backups, Withdrawals, Hide
   blanks, My wallets, the menu.
2. **The manual checklist** (further down): every feature as a numbered
   check (S1, B5, T3 ...) to go through by hand on the website and the
   phone - a **Quick pass** after small changes, the relevant parts (or
   everything) after bigger ones and before a new APK.

## Automatic website tests

### What they check

Each test opens the built website in a real Chrome browser (without a
window) as a brand-new visitor:

- **Start:** the Getting started checklist shows, and About shows the right
  version and the user counter.
- **Ask Devi:** the website answers are there (browser storage, Connect
  Klever Extension, Kleverscan in a new tab) and the app-only ones (scan
  notification, KLV Signer) are hidden.
- **Fetch/Update:** adding a wallet and fetching loads all Devikins,
  Weapons and Equipment, and stores every picture in the browser.
- **Pictures when Moonlabs is down:** the stored copies are shown; an
  NFT without a stored copy shows "Unavailable".
- **Backups:** a name and a 4-star rating survive Export all sets →
  Import a set in a second, empty browser, including the pictures (with
  the picture server down), and every file's checksum in the zip is
  right.
- **Getting started and menu:** the start checklist ticks off steps
  (wallet, fetch, backup), disappears when done and comes back from
  Help > Getting started; the menu categories open and close.
- **Message boxes:** on the website, the Hub's own message box doesn't
  pause the page - a running Fetch/Update finishes while one is open.
- **My wallets:** the set marked "My wallets" also lists the NFTs on the
  Withdrawals list (fetched by number), their details say where they
  are, and switching it off takes them out again.
- **Hide blanks:** NFTs whose picture is missing, plain white or only the
  background disappear when the switch is on (and come back when it's
  off); the setting is remembered; Compare hides the switches.
- **Withdrawals:** on a pretend blockchain, the tracker shows where each
  listed NFT is (arrived, in-game wallet, game's main wallet, another
  wallet, not found), turns a requested NFT "Overdue" after 30 minutes,
  and shows it as arrived once it's sent. Picking the in-game wallet
  from a wallet set works, and the whole tracker comes along in a full
  backup (Export all sets) into a new browser.
- **Damaged backups:** a backup with one changed byte in a picture is
  noticed and reported, not silently imported.

They never contact Klever, Moonlabs or the relay: every outside request
is answered by pretend servers with six made-up NFTs
(`tests/web/fakeServers.js`). So they work offline, always see the same
data, and put no load on anyone's server. A test fails if the website
tries to reach any other outside address.

They cover the **website** only. Phone-only parts (the scan
notification, saving backups to a folder, the KLV Signer) still need the
manual checklist below.

### One-time setup (on the Mac)

In Terminal, in the `app` folder:

```
npm install
npx playwright install chromium
```

The second line downloads the test browser (about 150 MB, once).

### Running them

```
npm test
```

This first builds the website (about a minute), then runs all tests
(a few minutes). Every test prints a ✓ when it passes or ✘ when it
fails, and the last line says e.g. `15 passed`.

- `npm run test:quick` runs the tests again without rebuilding - only
  useful when nothing in the app's code changed since the last build.
- `npm run test:report` opens a page with the results; for a failed
  test it includes a screenshot of what the browser showed at that
  moment.

If a test fails after a change, send Claude the ✘ lines (or the report
screenshot) - the test name says which part broke.

### When to run them

Before pushing changes that touch fetching, pictures, backups, the menu
or the help text - and in any case before pushing a bigger change.

## The manual checklist

A list of every feature, to go through after a change - like the KLV
Signer's TESTING.md. Every check has an ID (S1, B5, T3 ...) so you can
tell Claude exactly which one looked wrong ("T3: #1442 says Arrived but
it isn't").

- Tick a check by changing `- [ ]` to `- [x]` (or just keep notes).
- 🌐 = website only, 📱 = phone app only, no mark = both.
- After a small change, the **Quick pass** is enough. Before a new APK
  or after a bigger change, do the parts that the change touches - or
  everything.

### Release routine: everything, from scratch

For every release (for now), test the whole Hub the way a new user meets
it - your data is safe thanks to the backup:

1. **Back up:** Wallets → **Export all sets** (keep the zip somewhere
   safe; on the phone, Save to a folder). This includes the Withdrawals
   list.
2. **Start empty:** Wallets → Danger zone → **Reset All Data**. (On the
   website you can use a private window or a second browser instead,
   which leaves your normal one untouched.)
3. **Go through every part** below in order, from S1 - the Getting
   started checklist guides you through the set-up as a new user would.
4. **Restore:** Wallets → **Import a set** with the backup from step 1,
   load the imported set, and check your names, stars, pictures and
   Withdrawals list are back (that's S7, tested for real).
5. Switch **My wallets** on again for that set if you use it (it belongs
   to the set on this device, not to the backup).

### Before you start

- **Website:** reload the page (after GitHub has published: the About
  screen shows the new version).
- **Phone:** install the new APK, or with `npx expo start` running,
  shake the phone → **Reload**.
- Have your private wallet, your in-game wallet and your ID list at
  hand. For tests that change data (Reset, Delete), a second browser or
  a second wallet set is handy, so your real set stays as it is.

---

## Quick pass (5-10 minutes)

- [ ] **Q1.** The Hub opens; About shows the expected version.
- [ ] **Q2.** ☰ menu: the four categories open and close; Devikins /
      Weapons / Equipment each show their list.
- [ ] **Q3.** Search narrows the list; ✕ clears it.
- [ ] **Q4.** List ↔ Tiles; open an NFT, go back.
- [ ] **Q5.** Filters: pick one, Apply, Remove filters.
- [ ] **Q6.** Hide blanks and Deleted switches change the list.
- [ ] **Q7.** Fetch/Update runs and finishes (progress bar, then gone).
- [ ] **Q8.** Withdrawals: Check now finishes; statuses look right.
- [ ] **Q9.** Light/Dark toggle; everything readable.
- [ ] **Q10.** 📱 Android Back button: closes screens, needs two presses
      to leave the app.

---

## Part S — Set Up (Wallets, Fetch/Update, backups)

**S1. First visit and the Getting started checklist**
- [ ] A fresh Hub (new browser / Reset All Data) shows the **Getting
      started** checklist: 0 of 3 done.
- [ ] Each step's button opens the right screen (Wallets / Fetch now /
      Withdrawals).
- [ ] Steps tick off by themselves: wallet added → 1, a finished Fetch →
      2, Export all sets → backup. When all are done, the checklist
      disappears.
- [ ] "Hide ✕" removes it; ☰ → Help → **Getting started** brings it back
      ("All set ✓" when done).

**S2. Adding wallets**
- [ ] Add a wallet: the first one shows the "Wallet added" message about
      the first fetch; a second one doesn't.
- [ ] An invalid address is refused with a message; the same address
      twice isn't added twice.
- [ ] Edit a wallet's nickname; it stays after reopening the Hub.
- [ ] Delete a wallet: its NFTs leave the lists.
- [ ] 📱 Scan a wallet address with the camera (📷 button).
- [ ] 🌐 **Connect Klever Extension** adds the wallet open in the
      extension ("Already added" if it's there).

**S3. Wallet sets**
- [ ] **+ New set** with no name → "Wallet set 2" (next free number);
      with a name → that name.
- [ ] Tap a set to load it; its own wallets and NFTs show.
- [ ] Rename and Delete a set (Delete asks first).
- [ ] The storage line shows a sensible size per set.

**S4. My wallets**
- [ ] The switch shows for the loaded set; switching it on in another
      set moves it there (only one set can be yours).
- [ ] The link "Add the IDs of NFTs you own →" / "Your IDs (…) →" opens
      Withdrawals.
- [ ] With IDs on the list and My wallets on, the next Fetch/Update also
      loads those NFTs ("Withdrawals list: …" in the progress); they show
      in the lists.
- [ ] Switching My wallets off takes them out of the lists again.

**S5. Fetch/Update**
- [ ] The progress bar moves; tapping it shows "Fetch status" with
      details - and the fetch keeps going while that message is open.
- [ ] ✕ on the progress bar cancels.
- [ ] A long fetch (many new NFTs) first asks whether to go ahead.
- [ ] 📱 Switch to another app or lock the phone during a fetch: a
      notification shows it continues; back in the Hub it's still going.
- [ ] No internet (Airplane mode / Wi-Fi off) → a clear failed state, no
      hang.

**S6. Automatic retries**
- [ ] NFTs that failed ("Fetch failed - will retry") or are missing a
      picture are retried by themselves while the Hub is open (a
      "Retrying: …" bar), without tapping Fetch/Update.
- [ ] After updating to a version with the picture check: "picture
      checks" run once in the background.

**S7. Backups (Export / Import)**
- [ ] **Export all sets**: 🌐 a zip downloads; 📱 Save to a folder or
      Share.
- [ ] **Import a set** in another browser / phone: the set appears as
      "… (imported)", with names, stars and pictures; the message says
      everything matched.
- [ ] The Withdrawals list (wallets, IDs, marks) comes along with
      Export all sets.
- [ ] Website ↔ phone: a backup from one imports in the other.

**S8. Reset All Data** (only in a test browser / test phone!)
- [ ] Wallets → Danger zone → switch on → **Reset All Data**, confirm:
      everything is empty, like a new install; nothing crashes.

---

## Part B — Browse NFTs

**B1. Menu**
- [ ] Categories: Set Up · Browse NFTs · Tools · Help, Donate at the
      bottom. Tapping a category opens/closes it; the current screen's
      category is open and highlighted.
- [ ] 📱 KLV Signer (test) is under Tools; 🌐 it isn't there.

**B2. Lists and tiles**
- [ ] Each of Devikins / Weapons / Equipment scrolls smoothly; pictures
      and traits match the NFT.
- [ ] List ↔ Tiles is one choice for all three, and stays after
      reopening the Hub.
- [ ] The count at the top ("1,231 Devikins") makes sense.
- [ ] 📱 Turn the phone sideways and back: nothing clipped.

**B3. Search**
- [ ] Searching by ID, in-game name or your own nickname finds the NFT;
      ✕ clears; the search stays when switching between Devikins /
      Weapons / Equipment.

**B4. Sort**
- [ ] The sort button (e.g. "↑ ID", "↓ Rarity") changes the order;
      Rarity follows Common → Uncommon → Rare → Mythic → Eldritch.

**B5. Filters**
- [ ] Filters ▼ opens the panel; picking values shows **Apply Filters**;
      Apply narrows the list to all picked values together.
- [ ] Devikins: Rarity, Ancestry, Personality, Life Stage, Procreations
      Left, plus closed sections Genes / Affinities / Attributes.
- [ ] The Rating stars in the filters: Apply → exactly that rating.
- [ ] **Remove filters ✕** shows everything again (search still applies).
- [ ] A combination that matches nothing says so in words, e.g. "No
      Weapons match the filters: Rarity: Rare, Scaling: 80 to 100".
- [ ] Switching to another kind resets the filters (an applied star
      rating and the search stay).

**B6. Hide blanks**
- [ ] On: NFTs without details, without a picture ("Unavailable"), or
      with a plain white / background-only picture disappear.
- [ ] Off: they're back. The setting stays after reopening the Hub.
- [ ] Faceless Devikins (e.g. #1117747) stay visible (they're complete).

**B7. Deleted and comment**
- [ ] In an NFT's details: Mark as Deleted + a comment → greyed out in
      the list; with the **Deleted** switch on, hidden.
- [ ] A later Fetch/Update of an NFT you still hold un-deletes it and
      clears the comment (on purpose).

**B8. Name and rating**
- [ ] Type a name → **Save Name** lights up; only saved after tapping
      it. The name shows as a small pill on the tile/row.
- [ ] Stars save at once; **Clear Rating** (or tapping the lit star
      again) clears.
- [ ] Name and stars survive a Fetch/Update and an Export/Import.

**B9. NFT details**
- [ ] Traits match the NFT; tap the picture for full screen (Devikins).
- [ ] NFTs from your IDs list ("My wallets") show **Where it is (from
      your Withdrawals list)**, e.g. "In the game's main wallet (as of …)".
- [ ] **Changelog** appears only for NFTs with a recorded trait change.

**B10. Compare**
- [ ] Compare → "Tap one to compare" → pick two → side-by-side view;
      back returns to the list.
- [ ] While choosing, the Hide blanks / Deleted switches step aside and
      come back afterwards.

**B11. Look and feel**
- [ ] Light/Dark toggle; both readable (also the message boxes).
- [ ] 📱 Back button closes detail/screens; on a list, the first press
      shows "Press back again to exit", the second leaves.

---

## Part T — Tools

**T1. Withdrawals: wallets**
- [ ] **Choose from my wallets** fills the fields from your sets
      (nickname + set name); pasting works too; Save.
- [ ] Wrong addresses are refused (not klv1…, the same twice, the game's
      main wallet).
- [ ] "Overdue after (minutes)" can be changed and is kept.

**T2. Withdrawals: adding IDs**
- [ ] Pasting your list file with its headings ("Devikin ID's",
      "Weapon IDs", "Equipment IDs") sorts the IDs into the right kinds;
      the wallet addresses in the file are listed as skipped.
- [ ] Without headings: pick Devikins / Weapons / Equipment first.
      D123 / W123 / E123 work anywhere.
- [ ] Pasting the same list again adds nothing twice.
- [ ] "I've requested these in the game just now" marks them requested.

**T3. Withdrawals: checking**
- [ ] **Check now** (requested + new IDs) and **Full check** (all;
      minutes for long lists) finish with "Last check: …".
- [ ] Statuses: Arrived (date + sender), In your in-game wallet, In the
      game's main wallet, In another wallet (held by …), Not found on
      the chain, Not checked yet; each with "as of …".
- [ ] Compare a few with Kleverscan: the place is right.

**T4. Withdrawals: requested and overdue**
- [ ] Select rows → **Mark requested** / **Clear mark** / **Remove**
      (Remove asks first).
- [ ] A requested NFT not arrived after the set minutes → **Overdue**
      (red); the "Copy (🌐) / Share (📱) the overdue list" button gives a
      text for a support ticket.
- [ ] Once it arrives, Check now shows it as Arrived.

**T5. Withdrawals: filter and sort**
- [ ] Kind (All kinds / Devikins / Weapons / Equipment), place
      (Anywhere / Still in the game / …) and order (Needs attention
      first / ID ↑ / ID ↓) narrow and sort the list; the status chips'
      counts follow.
- [ ] "Select all N shown" selects exactly what's shown.

**T6. Withdrawals: arrivals log**
- [ ] Lists what came into your receiving wallet, newest first, with
      sender ("your in-game wallet", "the game's main wallet" or an
      address); tapping one opens the transaction on Kleverscan.

**T7. Breeding Helper**
- [ ] Pick a Devikin: possible partners show (same rarity, procreations
      left, not Eldritch); filters/tolerance change the result.

**T8. 📱 KLV Signer (test)** (needs the KLV Signer app with a testnet
wallet - see the Signer's TESTING.md)
- [ ] **Connect KLV Signer** → the Signer asks "Allow this app?" (DLH,
      `com.raphaelrohner.devikinslegacyhub`) → back in the Hub with
      address and testnet balance; remembered when coming back.
- [ ] Receiver (typed or **Scan**) + amount → **Send with KLV Signer** →
      the Signer shows exactly that → approve → "✔ Sent to the testnet"
      + Kleverscan link; balance updates.
- [ ] Reject in the Signer → "Cancelled in the KLV Signer - nothing was
      sent."
- [ ] Invalid receiver or amount → plain message, the Signer isn't
      opened.

---

## Part H — Help, About, Donate

**H1. Kleverscan**
- [ ] 📱 Opens the Devikins holders list inside the Hub; 🌐 opens it in a
      new browser tab.

**H2. Feedback**
- [ ] Pick a category, write a message → **Open Email Draft** opens your
      email app with a filled-in draft (version, category, message).
      Empty message → button disabled.

**H3. Ask Devi**
- [ ] All questions with answers are listed; typing a question (even
      with a small typo) finds the right answer; nonsense gets the
      friendly fallback.
- [ ] 🌐 Website answers show (browser storage, Connect Klever Extension,
      Kleverscan in a new tab); app-only ones (scan notification, KLV
      Signer) don't. 📱 The other way round.
- [ ] New answers are there: Getting started, My wallets, Withdrawals,
      Hide blanks.

**H4. About**
- [ ] Version and Website/Android app; the Users table (Hubs and Visits
      for Today / 7 days / 30 days / Since launch).
- [ ] "Count me (anonymously)" switch works; the privacy text is right.

**H5. Donate**
- [ ] The address shows; Copy (🌐) and View on Kleverscan work.
- [ ] 🌐 Donate with Klever Extension: the extension asks for
      confirmation (fee note ~3 KLV); Reject → message, nothing sent.

---

## Part W — 🌐 Website extras

- [ ] **W1.** Close the tab and the browser, open the site again:
      wallets, NFTs, names, stars and the Withdrawals list are all still
      there.
- [ ] **W2.** Message boxes are the Hub's own (inside the page, matching
      Light/Dark) and don't stop a running fetch.
- [ ] **W3.** Pictures still show when Moonlabs' picture server is down
      (stored copies); a picture never stored says "Unavailable".
- [ ] **W4.** On a phone browser (e.g. Safari): the layout fits; the two
      switches move to their own line under List / Tiles / Compare.

---

## When to test

- **Quick pass**: after a small change (wording, a colour, one button).
- **The parts it touches**: e.g. a change to Withdrawals → Part T; to
  fetching or the database → S5, S6, S7, B2.
- **Everything**: before a new APK release.
- The automatic tests (`npm test`, and GitHub on every push) cover a
  good part of the website already - this list is for what a person
  should look at, and for the phone app.
