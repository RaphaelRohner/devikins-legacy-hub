# TESTING.md — How to test Devikins Legacy Companion

There's no automated test suite for this app (no Jest, no CI). For a
small, personal, one-off app like this, that's the right call - setting
up and maintaining an automated testing framework would be a lot of
ongoing overkill for the little it would catch, versus just trying the
real app on your real phone with your real wallets. What this file gives
you instead is a repeatable manual checklist, split into a **quick pass**
(a few minutes, after any small change) and a **full pass** (15-20
minutes, before building a new APK or after a bigger change) - see
"When to test" at the bottom for which one to reach for.

Whenever a change is made, ask what it touches and check just that
section below with the quick pass in mind - you don't need to redo the
whole full pass after every tiny tweak, only after ones that could have
wider ripple effects (anything touching the database, the fetch process,
or shared layout/navigation code).

## Before you start

- Reload the app first (shake your phone → **Reload**, or if the
  Terminal window running `npx expo start` is open, click into it and
  press `r`) so you're testing the current code, not a stale build.
- Have at least one wallet address handy that you know holds Devikins,
  Weapons, and Equipment, so the list/detail views actually have data to
  show.
- Wallets, Fetch/Update, and Feedback all now live behind the ☰ menu
  button (V2) rather than sitting on the home screen - open the menu
  whenever a step below says to use one of them.

## Quick pass (a few minutes)

Good enough after most small tweaks (wording, colors, spacing, a single
button).

1. Open the app. It should reach the home screen within a few seconds
   (loading screen shows briefly, then disappears).
2. Tap the ☰ menu button and switch between Devikins / Weapons /
   Equipment - each should show its list without errors, and the menu
   should highlight whichever one you're currently on.
3. Type something into the top search bar - the list should narrow as
   you type, and a small "✕" should appear at the right edge of the
   field. Tap it - the text should clear and the list should go back to
   showing everything (the "✕" itself should disappear once the field
   is empty again).
4. Tap "Show filters" - the **Rating** row should be right at the top,
   above the other filter dropdowns. Tap one of its five stars - it and
   every star before it should light up together (same look as the
   Rating control in an NFT's detail view), but the list should NOT
   narrow yet and an **Apply Filters** button should appear - tapping a
   star now joins the same pending/Apply step as every other filter,
   rather than narrowing the list right away. Tap **Apply Filters** -
   now the list narrows to that exact rating (still an exact match
   under the hood, only the display changed) and the panel closes. Tap
   the same star again, then Apply, to clear it. Pick one of the other
   filters and tap **Apply Filters** - the list should narrow further.
   Tap **Remove filters ✕** - it should go back to showing everything
   except the search text, which should still apply on top of that.
   Now pick a combination guaranteed to match nothing (e.g. a star
   rating nothing has, or a Rarity plus a numeric range that don't
   overlap) and tap Apply Filters - the empty state should name the
   collection and every applied filter, e.g. "No Weapons match the
   filters: Rarity: Rare, Scaling: 80 to 100". Pick just ONE thing
   (say, only a star rating) and confirm it switches to singular:
   "No Weapons match the filter: Rating: 4 stars". Not a generic "No
   NFTs match these filters", and not "NFTs" tacked onto the collection
   name either (it's "No Weapons match...", not "No Weapons NFTs
   match...").
5. Tap the **List/Tiles** toggle (top-right of the search row) - the
   layout should switch between the normal picture-plus-traits rows and
   a compact grid of just pictures. Switch to a different tab (Devikins/
   Weapons/Equipment) - it should still be showing the same List/Tiles
   choice, not reset back to List.
6. Tap an NFT in the list (or a tile) - its detail view should open. Use
   the phone's **system Back button/gesture** to close it (not just the
   app's own back button) - you should land back on the list, not leave
   the app.
7. Toggle the light/dark mode button (top-right of the very first row,
   next to the ☰ menu button) - colors should flip and stay readable.
8. On a collection screen's list view (nothing else open), press the
   system Back button/gesture once - you should see a brief "Press back
   again to exit" toast, and the app should stay open. Press Back again
   right away - now it should actually exit.
9. If nothing looks broken and nothing crashed, you're done.

## Full pass (15-20 minutes)

Worth doing before building a new APK to share, or after any change to
the database, the fetch process, wallet handling, or navigation/back
button behavior.

### 1. Fresh start

- Open the **Wallets** screen, scroll to **Danger zone**, tap
  **Reset All Data**, confirm. This wipes every saved wallet, every NFT,
  and every downloaded image - the same state as a brand-new install,
  without needing to actually reinstall anything.
- Confirm the three tabs now show empty/"no NFTs yet" states, not stale
  data or a crash.

### 2. Adding wallets

- Add your first wallet address. You should see the one-time popup
  explaining that the first fetch takes a while.
- Add a second, different wallet address (no popup this time - it's
  first-wallet-only).
- Try adding an obviously invalid address (too short, wrong format) and
  confirm the app rejects it with a message rather than silently
  accepting garbage.
- Try adding the same address twice - it shouldn't create a duplicate.

### 3. Fetching

- Tap **Fetch/Update**. Watch the progress indicator move.
- While it's running, switch to another app for 10-20 seconds, then come
  back - the fetch should resume/continue rather than losing progress
  (nothing is lost even if interrupted, since each NFT saves to the
  database the moment it's individually fetched, not all at once at the
  end).
- If a fetch leaves anything stuck failed/imageless, confirm it stays
  that way until you tap **Fetch/Update** again - there's no automatic
  background retry any more (removed per feedback; see NOTES.md), so
  nothing should happen on its own without you tapping that button.
- Let a fetch finish fully. Check all three tabs now show NFTs for both
  wallets you added.
- Turn on Airplane Mode, tap Fetch/Update again, and confirm you get a
  clear "failed"/"unavailable" state rather than a silent hang or crash.
  Turn Airplane Mode back off afterward.

### 4. Browsing each tab

For **each** of Devikins, Weapons, and Equipment:

- Scroll the full list - images and names should load in, no visual
  glitches, no flickering/jumping while scrolling.
- Set List/Tiles to Tiles on this tab, then switch to the other two tabs
  - both should already be showing Tiles too (List/Tiles is one shared
  choice across all three, not per-tab). Restart the app and confirm
  Tiles is still selected everywhere.
- Tap into a few different NFTs - their detail views should show correct
  stats/traits for that specific item (not another one's data).
- Tap an NFT's image to open the fullscreen viewer (Devikins), then
  close it.
- Rotate the phone to landscape and back on both a list and a detail
  view - layout should adapt, not clip or overlap.

### 5. Filters, in depth

- Open filters, apply two or three at once, tap **Apply Filters** - the
  list should match all of them together (not just the last one picked).
- For a Devikin's **Rarity** filter specifically, confirm the dropdown
  order is All, Common, Uncommon, Rare, Mythic, Eldritch - not
  alphabetical.
- Open Filters on the **Devikins** tab specifically (V2) - right below
  Rating, you should see only Rarity, Ancestry, Personality, Life
  Stage, and Procreations Left as plain rows, then three closed
  sections: **Genes ▼**, **Affinities ▼**, **Attributes ▼**. Tap each
  one open (▼ becomes ▲) and confirm: Genes has all five gene traits
  (Eyes/Mouth/Ears/Hair/Horns Gene), Affinities has Overall Affinity
  plus the five element Affinities, Attributes has the five element
  Attributes - 21 filters total across everything visible/expanded, and
  nothing missing or duplicated between sections. Pick a filter from
  inside a collapsed section (expand it, pick a value, don't collapse
  it back down) and tap **Apply Filters** - it should narrow the list
  exactly like any other filter, whether its section is open or closed
  at the time. Hide filters, then Show filters again - all three
  sections should be back to closed (this resets every time the panel
  itself is hidden/shown - it's just a display choice, not a picked
  filter, so this is expected, not a bug). Switch to **Weapons** or
  **Equipment** and confirm their filters are still one flat list, not
  grouped - Devikins is the only one grouped so far.
- With a filter applied, confirm the layout is two rows ("Show
  filters"/"Remove filters" on top, count/Deleted switch below); with no
  filter applied, confirm it collapses back to one row. Tap Show/Remove
  filters and the Deleted switch a bunch of times in a row in both
  states to make sure nothing is unresponsive.
- Switch tabs while a filter is applied and the panel is expanded - the
  panel should close and the filter should reset on the new tab (not
  carry over/stay open). The top search bar's text is a deliberate
  exception (V2) - it's meant to carry over across tabs, so confirm it
  DOESN'T reset when you switch. The Rating row's star filter is a
  partial exception: an already-**applied** star rating carries over
  across tabs same as search does, but a star you've tapped and NOT yet
  applied (no Apply Filters tap yet) does NOT carry over - switching
  tabs with an unapplied star pick should drop it, same as it drops any
  other unapplied trait pick.

### 6. Deleted / comment (the manual "I sold this" feature)

- Open an NFT you still hold, mark it **Deleted**, add a short comment,
  save.
- Confirm it now shows greyed out in the list (still visible, not
  hidden) unless the **Deleted** switch is on, in which case it
  disappears from the list entirely.
- Run **Fetch/Update** again. Since this NFT is still in your wallet,
  confirm it comes back as *not* deleted afterward, with the comment
  cleared - this is intentional, not a bug (see NOTES.md's "Multiple
  wallets, and marking NFTs as deleted" section for why). This is
  unchanged by V2 - only `custom_name`/`star_rating` (section 9 below)
  were given the opposite treatment (persisting across a re-fetch), on
  purpose, since neither of those has anything to do with whether you
  still hold the NFT.

### 7. Multiple wallets

- With two+ wallets added, confirm the lists show combined NFTs from
  all of them, not just one.
- Rename a wallet on the Wallets screen and confirm the new name sticks
  after reloading the app.
- Remove one wallet and confirm its NFTs disappear from the lists (its
  locally-stored data goes with it).

### 8. General app behavior

- Force-close the app entirely (not just background it) and reopen it -
  your wallets and NFTs should still be there (they're saved to the
  phone, independent of the app process).
- Leave the app fully idle for a few minutes, then come back - it
  shouldn't have crashed or lost its place.
- Check the loading screen on a cold start lasts roughly 3 seconds, not
  noticeably longer or so short it flashes unreadably.

### 9. Name & Rating (V2)

- Open an NFT's detail view, tap into the Name field, type a nickname.
  The **Save Name** button below it should go from greyed-out to its
  normal color as soon as you've actually changed something. Tap away
  (or Done/Return) WITHOUT tapping Save Name, then reopen the NFT - the
  nickname should NOT have saved (nothing commits until Save Name is
  tapped).
- Type the nickname again and this time tap **Save Name** - it should
  go back to greyed-out (nothing left to save), and reopening the NFT
  should show the nickname persisted.
- Tap a star in the Rating control - it and every star before it should
  light up together (same look as the Rating row's star filter under
  Filters), and this one still saves immediately on tap, no button
  needed. A **Clear Rating** button should now appear right below the
  stars - tap it and the rating should clear back to unrated, and the
  button itself should disappear again (nothing left to clear). Rate it
  again and confirm tapping the same (already-lit) star a second time
  does the same thing as Clear Rating. Try this for one NFT in each of
  Devikins, Weapons, and Equipment - all three share the same detail
  view code, but worth a quick check in each tab.
- Go back to the list, then reopen the same NFT - both the name and the
  rating should still be there.
- In the top search bar, search for the nickname you just gave it - it
  should find that NFT (search matches the nickname as well as the
  in-game name and the ID). Open Filters, tap that same star count in
  the Rating row, then tap **Apply Filters** - it should show up there
  too (an exact match, not "N or higher").
- Run **Fetch/Update** again and confirm both the name and the rating
  survive the re-fetch (same underlying fix as section 6 above - these
  two columns are just as local/user-entered as `deleted`/`comment`).
- Go back to the overview (list or tiles) and confirm the nickname shows
  as a small pill in that item's top-right corner - without opening it.
  An NFT with no nickname given should show no pill at all.

### 10. Feedback (V2)

- Open the ☰ menu → Feedback.
- Fill in "Your email" and confirm it accepts a normal email address
  (this is YOUR own address, for Raphael to reply to - not where the
  draft gets sent).
- Tap the category dropdown and confirm all three options (Feature
  request / Bug report / Feedback) are listed; pick one and confirm it
  shows as selected.
- Type a short message, tap **Open Email Draft** - your phone's email
  app should open with a new draft addressed to
  `chibitales2@gmail.com`, subject line
  `Devikins Legacy Companion v<version> - <category>`, and a body in
  this exact fixed order: `App: Devikins Legacy Companion v<version>`,
  `Email: <what you typed>` (or `(not provided)` if you left it blank),
  `Feedback type: ...`, `Name: ...` (or `(not provided)` if you left it
  blank), then `Message:` followed by what you typed. You do NOT need
  to actually send it for this test - confirming the draft opens
  correctly, pre-filled in that order, is enough.
- Leave the message field empty and confirm **Open Email Draft** is
  disabled (there's nothing to send yet). The email and name fields
  should both stay optional - blank is fine for either.
- If your phone/emulator has no email app configured at all, confirm you
  get a clear alert with the feedback address and your message, instead
  of a silent failure or crash.

### 11. Devi, the offline helper (V2)

- Open the ☰ menu → Ask Devi (Help).
- Confirm the greeting message is there and clearly says it's not a
  real AI.
- Scroll down and confirm every FAQ question is listed with its answer
  directly underneath it, one after another (not hidden behind
  anything you have to tap first).
- Type one of the FAQ questions in your own words (e.g. "how do stars
  work") into the box at the bottom and confirm it still matches
  sensibly, appending as a new exchange above the FAQ list.
- Type a question with a typo in a keyword (e.g. "how do i add a
  walet") and confirm it still matches the right answer - Devi's
  matching tolerates small typos, not just exact keyword spelling.
- Ask about something that was recently changed (e.g. "does it retry
  automatically" or "where's dark mode") and confirm the newer FAQ
  entries show up and are accurate to current behavior.
- Type something completely unrelated (e.g. "what's the weather") and
  confirm you get the friendly fallback message, not a crash or a made-
  up answer.
- Confirm the screen scrolls to show the newest typed exchange, and
  that the "‹" back button (top-left corner) returns you to whichever
  tab you were on.

## When to test

- **Quick pass**: after a small visual/wording tweak, or a change scoped
  to one screen/button.
- **Full pass**: before building a new APK to share, after any change
  touching the database, the fetch/retry logic, wallet handling, or
  back-button/navigation behavior, or any time something felt "off" and
  you want confidence it's actually fixed everywhere, not just where you
  noticed it.
- Either way, a plain **reload** (shake → Reload, or `r` in the Terminal)
  is enough to pick up code changes - you never need to fully restart
  Expo or reinstall Expo Go for that. Restarting Expo also does **not**
  touch your saved wallets/NFTs/images - those live in the phone's own
  storage, separate from the dev server (see SETUP.md's testing-related
  section for more on this distinction).
