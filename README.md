# Devikins Legacy Hub

A fan-made companion for players of Devikins (a game on the Klever
blockchain): browse your Devikins, Weapons and Equipment, keep track of
withdrawals from the game, find breeding partners, and chat with other
players.

🌐 **Website:** https://raphaelrohner.github.io/devikins-legacy-hub/
📱 **Android app:** the APK under [Releases](../../releases)

## What it does

- **Your collection:** reads your Devikins, Weapons and Equipment straight
  from the Klever chain and the game's public metadata. No login, no
  account, just your wallet address(es).
- **Filters and sorting** built from your own data (rarity, genes,
  affinities, stats and more), star ratings, your own names (or the ones
  you gave them in the game), list and tile views.
- **Wallet sets:** keep separate collections side by side, for example a
  second player in the household.
- **NFTs still in the game:** add their IDs and they show in your
  collection, with where they are.
- **Withdrawals tracker:** checks where each NFT is, marks overdue
  withdrawals, and writes a ready-made text for a Klever support ticket.
- **"Where are my NFTs?":** a table of every wallet holding your NFTs.
- **Breeding Helper**, a guided setup, and an offline helper ("Ask Devi")
  that explains the game's words and the Hub.
- **Chat (beta, website and Android app):** one-to-one chats and open groups for Devikins
  holders, end-to-end encrypted. See below.
- **Collectors Albums (new):** show chosen NFTs from one of your wallets,
  with a note on each ("Bonded Yoda") and in sections ("May event 2025"),
  and browse other players' albums, also on the website without signing
  in, filtered by kind, rarity or ancestry. Each NFT is checked: the wallet
  proved it's the owner's, and the Hub asks Klever whether the NFT is still
  in it. Anonymous unless you choose to show your chat nickname.
- **Backups:** "Export all sets" saves everything to a file (the chat
  locked with a password of your choice).

## Safety

- The collection features only **read** public data. The Hub never asks
  for a private key or password, and can't move or sell anything.
- Your data is stored on your own device (in the browser, or in the app).
- **Chat sign-in** is a signature of a short text with your Klever wallet:
  not a transaction, free, and it can't move anything. It proves you hold
  Devikins.
- **Chat messages** are encrypted on your device. The small server that
  passes them on (the "postman", a Cloudflare Worker, code in
  `app/chat/postman`) can't read them and doesn't keep wallet addresses
  (only those of voters, briefly, until a vote is counted). Its README
  lists exactly what it stores.
- **Collectors Albums are public on purpose.** The album screens don't
  show the wallet or the NFTs' numbers, but both are in the album's data
  (the proof is a signature by that wallet, again not a transaction), so
  someone determined can find the wallet. The Hub tells you before you
  publish one; a separate showcase wallet keeps your main one private.
- **Found a security problem?** Please report it privately, see
  [SECURITY.md](SECURITY.md).

## The chat in short

- Holders only: at least one Devikin to join, and as many posts per day in
  groups as Devikins held (the group's owner can always answer).
- Open groups: anyone can join; the owner pins up to 5 messages. Starting
  a group takes 10 Devikins, and a group nobody joins goes after 30 days.
- Members holding 10+ Devikins can vote someone out of a group; the
  wallets are checked again when the vote closes.
- Reactions 👍 👎 ❤️ 😂 😮 🔥 (free).
- Website: works with the Klever browser extension (Chrome) and in the
  Klever app's own browser on Android.
- Android app: you sign in through the **KLV Signer** app (version 0.1.3 or
  newer), so your key stays in one place.
- **Linked devices:** use the chat on several devices (website, phone; up
  to 5) as one account. Sign in with the same wallet, or link a device by
  **QR code** (no wallet needed on it). Your devices stay in sync, and a new
  one gets your history once you say yes on one you already use.

## Limitations

- **Android app** as an APK from Releases, not the Play Store: you'll need
  to allow installs from unknown sources. Built for ARM phones (32- and
  64-bit, i.e. practically all phones), not for x86 emulators or
  Chromebooks. Other systems: use the website.
- **The chat backup is website-only for now** (in the Android app, link
  the phone to another device instead). On iPhone, the Klever app's browser
  should work for the website's chat, but it hasn't been tested yet.
- **The chat is a beta** on one small server: expect the odd rough edge.
  A chat brought into a second browser with a backup (instead of linking
  it) can split the messages between the two: link devices instead.
- **No Devikin "Level"**: it lives in the game studio's own backend, out of
  reach.
- **Pictures** come from the game studio's server and can lag behind an
  in-game change, or occasionally be blank on their side.
- The game's metadata service can be slow or briefly fail; the Hub retries
  by itself.
- Built and tested by one person on his own devices.
- No marketplace or trading.
- A personal project, not affiliated with or endorsed by Moonlabs or
  Klever.
