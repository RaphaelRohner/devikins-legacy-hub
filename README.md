# Devikins Legacy Companion

A personal companion app for browsing your Devikins NFTs (a Klever-blockchain
game) — characters, weapons, and equipment — pulled straight from your own
wallet, with filtering, sorting, and stat tracking the in-game view doesn't
offer.

## What it does

- Reads your Devikins, Weapons, and Equipment NFTs directly from the Klever
  chain and the game studio's own metadata service — no login, no account,
  just a wallet address.
- Filters built from your own data (rarity, genes/affinities, stats, and
  more), not a fixed hardcoded list, plus star ratings, custom nicknames,
  and list/tile views sortable by rarity or recently added.
- **Wallet sets**: keep fully separate, independently-saved collections side
  by side — handy for a second player in the household, or checking a
  friend's collection, without touching your own.
- A QR scanner for adding a wallet address, and a built-in browser tab
  straight to Kleverscan's holder/transaction data for the collection.
- Everything is stored locally on your device (SQLite) — nothing leaves your
  phone except read-only calls to Klever's and the game studio's public
  APIs.
- Scales to tablets, and includes an offline in-app FAQ helper ("Devi") for
  "how do I..." questions.

## Limitations

- **Android only**, distributed as a downloadable APK from this repo's
  Releases, not the Play Store — you'll need to allow installs from unknown
  sources.
- **Shows your personal wallet only.** NFTs sitting in the game's own
  in-game wallet, or in staking/contract addresses, aren't shown — the app
  tracks whatever wallet address(es) you add, not what's currently active
  in-game.
- **No Devikin "Level" tracking** — Level lives in the game studio's own
  backend, not in any data this app can reach.
- **Images aren't always up to date or available.** They come straight from
  the game studio's own CDN, which the app checks periodically for updates
  but doesn't control — an item's picture can occasionally lag behind an
  in-game art change, or in rare cases just be a blank placeholder on the
  studio's own side, with nothing wrong on the app's end.
- Depends on the game studio's own metadata service, which can occasionally
  be slow or briefly fail. The app retries automatically, but a very slow
  connection may need a manual refresh.
- Built and tested solo on the developer's own phone and tablet — not
  broadly tested across Android hardware.
- No chat, friends list, or other social features, and no built-in
  marketplace or trading — this is a personal collection browser, not an
  account/social system.
- A personal project, not affiliated with or endorsed by Moonlabs or Klever.
