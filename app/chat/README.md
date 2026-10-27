# chat/ — the Hub's chat core (portable)

The logic of the Hub's chat, **without any screens**, so it can be moved
into another app as it is. Design and decisions: the claude.ai project
document CHAT-DESIGN-DRAFT.md (21 Oct 2026). Stage 0 of the build plan.

What's in here, in plain words:

| File | What it does |
|---|---|
| `src/identity.js` | A **chat key** for each device: a new key made only for the chat. It is **not** a wallet key and can't move any NFT or coin. |
| `src/direct.js` | Sealing and opening **1:1 messages** with Nostr's published formats (NIP-44 encryption inside a NIP-59 "gift wrap"). The postman only sees a sealed envelope for a device; who sent it is inside the seal. |
| `src/group.js` | **Group messages**: one sealed envelope per message for the whole group (stored once per group, not once per member), with a group key that only members' Hubs hold (new members only get posts from the moment they join: the postman hands them nothing older; renewing the key when someone is removed comes with the votes, stage 4). Also the owner's **pinned message** and the group's **key check** (a fingerprint stored at the postman, so a newcomer only accepts the real key). Every Hub drops posts that come too early for the author's holdings (counted per player), and old posts sent again. |
| `src/badge.js` | The postman's **signed badge** ("this chat key belongs to a verified holder of N NFTs, valid until …") – no wallet inside. |
| `src/rules.js` | The agreed **rules** as plain calculations: posting limits by holdings, the pause between contact requests, the automatic voting threshold, and how a removal vote is decided. |
| `src/httpAuth.js` | Signs each request to the postman with the device's chat key (Nostr's published "HTTP Auth", NIP-98); the postman checks it with the same file. |
| `src/client.js` | One small function per postman request; `publicAlbums` reads the albums without signing in (and checks each one). |
| `src/messenger.js` | One device's chat, ready for screens: sign-in, nickname, finding players, contact requests with **drop codes**, accept / decline / block / unblock, sending and collecting 1:1 messages, history in a local database (passed in, expo-sqlite style). |
| `src/album.js` | **Collectors Albums** (27 Oct 2026): an album has its own key and is signed with it; the wallet whose NFTs it shows signs a short text naming that key (not a transaction). `checkAlbum` checks both, for every viewer. Shared by the Hub and the postman. |
| `src/backup.js` | Locks the chat part of a backup with a password (the browser's own Web Crypto: PBKDF2-SHA-256 with 600,000 rounds, then AES-256-GCM). A forgotten password can't be recovered. |
| `src/fakePostman.js` | A pretend postman for the automatic tests of the core. |
| `postman/` | The **real postman**, a Cloudflare Worker (stage 1) – see `postman/README.md`: what it keeps, its requests, and how to put it on Cloudflare. |

Rules for this folder:
- **No home-made encryption.** Sealing and signatures come from
  `nostr-tools` (the NIP-44 encryption it implements was audited by Cure53
  in 2023), which uses the audited `@noble` libraries.
- **No wallet keys, ever.** Proving NFT ownership is done once with the
  Klever browser extension ("sign a text", no fee); the chat only ever
  holds its own chat keys.
- **Text only.** Messages are plain text with a size limit; nothing is
  loaded from links.
- No React, no Expo, no screens in here — only plain JavaScript, so the
  automatic tests run on a computer (`npm run test:chat`).
