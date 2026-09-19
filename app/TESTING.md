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
   you type. Tap one of the five stars next to it - the list should
   narrow to only that exact rating; tap the same star again to clear it.
4. Tap "Show filters", pick one filter, tap **Apply Filters** - the list
   should narrow. Tap **Remove filters ✕** - it should go back to
   showing everything (search text and the star filter, if any, should
   still apply on top of that).
5. Tap the **List/Tiles** toggle - the layout should switch between the
   normal picture-plus-traits rows and a compact grid of just pictures.
6. Tap an NFT in the list (or a tile) - its detail view should open. Use
   the phone's **system Back button/gesture** to close it (not just the
   app's own back button) - you should land back on the list, not leave
   the app.
7. Toggle the light/dark mode button - colors should flip and stay
   readable.
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
  (nothing is lost even if interrupted, since each NFT saves the moment
  it's fetched - see NOTES.md's "Automatic retry timer" section).
- Let a fetch finish fully. Check all three tabs now show NFTs for both
  wallets you added.
- Turn on Airplane Mode, tap Fetch/Update again, and confirm you get a
  clear "failed"/"unavailable" state rather than a silent hang or crash.
  Turn Airplane Mode back off afterward.

### 4. Browsing each tab

For **each** of Devikins, Weapons, and Equipment:

- Scroll the full list - images and names should load in, no visual
  glitches, no flickering/jumping while scrolling.
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
- With a filter applied, confirm the layout is two rows ("Show
  filters"/"Remove filters" on top, count/Deleted switch below); with no
  filter applied, confirm it collapses back to one row. Tap Show/Remove
  filters and the Deleted switch a bunch of times in a row in both
  states to make sure nothing is unresponsive.
- Switch tabs while a filter is applied and the panel is expanded - the
  panel should close and the filter should reset on the new tab (not
  carry over/stay open). The top search bar's text and star filter are
  a deliberate exception (V2) - those two are meant to carry over across
  tabs, so confirm they DON'T reset when you switch.

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

- Open an NFT's detail view, tap into the Name field, type a nickname,
  then tap away (or Done/Return) to unfocus it - it should save without
  needing a separate button.
- Tap a star in the Rating control - it and every star before it should
  light up together (unlike the top bar's star filter, this one fills
  cumulatively). Tap the same star again - the rating should clear back
  to unrated.
- Go back to the list, then reopen the same NFT - both the name and the
  rating should still be there.
- In the top search bar, search for the nickname you just gave it - it
  should find that NFT (search matches the nickname as well as the
  in-game name and the ID). Tap that same star count in the top bar's
  star filter - it should show up there too (an exact match, not "N or
  higher").
- Run **Fetch/Update** again and confirm both the name and the rating
  survive the re-fetch (same underlying fix as section 6 above - these
  two columns are just as local/user-entered as `deleted`/`comment`).

### 10. Feedback (V2)

- Open the ☰ menu → Feedback.
- Pick each of the three categories (Feature request / Bug report /
  Feedback) and confirm the selected one is visibly highlighted.
- Type a short message, tap **Open Email Draft** - your phone's email
  app should open with a new draft addressed to
  `[old feedback address removed]`, with the subject/body already
  filled in (app name, version, category, name if you gave one, and
  your message). You do NOT need to actually send it for this test -
  confirming the draft opens correctly, pre-filled, is enough.
- Leave the message field empty and confirm **Open Email Draft** is
  disabled (there's nothing to send yet).
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
- Type something completely unrelated (e.g. "what's the weather") and
  confirm you get the friendly fallback message, not a crash or a made-
  up answer.
- Confirm the screen scrolls to show the newest typed exchange, and
  that "‹ Back to Home" returns you to whichever tab you were on.

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
