# chat/ — the Hub's chat core (portable)

The logic of the Hub's chat, **without any screens**, so it can be moved
into another app as it is. Design and decisions: the claude.ai project
document CHAT-DESIGN-DRAFT.md (21 Oct 2026). Stage 0 of the build plan.

What's in here, in plain words:

| File | What it does |
|---|---|
| `src/identity.js` | A **chat key** for each device: a new key made only for the chat. It is **not** a wallet key and can't move any NFT or coin. |
| `src/direct.js` | Sealing and opening **1:1 messages** with Nostr's published formats (NIP-44 encryption inside a NIP-59 "gift wrap"). The postman only sees a sealed envelope for a device; who sent it is inside the seal. |
| `src/group.js` | **Group messages**: one sealed envelope per message for the whole group (stored once per group, not once per member), with a group key that is renewed whenever someone joins or is removed (new members only read from the moment they join). |
| `src/badge.js` | The postman's **signed badge** ("this chat key belongs to a verified holder of N NFTs, valid until …") – no wallet inside. |
| `src/rules.js` | The agreed **rules** as plain calculations: posting limits by holdings, the pause between contact requests, the automatic voting threshold, and how a removal vote is decided. |
| `src/fakePostman.js` | A pretend postman for the automatic tests (the real one will be a Cloudflare Worker). |

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
