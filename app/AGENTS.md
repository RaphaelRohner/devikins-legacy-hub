# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Signing (KLV Signer)

The Hub never stores or handles private keys. Anything that needs a
signature goes through the separate KLV Signer app (`src/api/klvSigner.js`,
rules in the KLV Signer project's `SIGNER-PROTOCOL.md`). Don't add key
import/storage to the Hub. Transactions are testnet-only for now
(`src/api/kleverTx.js`).

## Chat (stage 0 and 1 since 21 Oct 2026)

The chat core lives in `chat/` (plain JavaScript, no screens, so it can move
to another app; see `chat/README.md` and the design in the KLV Signer
project's CHAT-DESIGN-DRAFT.md). It holds **chat keys**: keys made only for
the chat, one per device. They are NOT wallet keys and can't move NFTs or
coins, so the rule above still holds: no wallet keys in the Hub. Never use
a wallet key as a chat key. No home-made encryption: sealing and signatures
come from `nostr-tools` (Nostr's published NIP-44 / NIP-59 formats).
Tests: `npm run test:chat`.

The "blind postman" (stage 1, 21 Oct 2026) is in `chat/postman/`: a
Cloudflare Worker with one Durable Object (SQLite). Its rules are in
`chat/postman/src/postOffice.js`, tested on a computer by
`chat/tests/postman.test.mjs`. Keep it blind: never store a wallet address
or NFT count, never log (Cloudflare logs are off in `wrangler.toml`), and
add to the "what it keeps" list in `chat/postman/README.md` before storing
anything new. Raphael deploys it himself (README there).

The Chat screen (stage 2a, 22 Oct 2026) is `src/components/ChatView.web.js`
(website only; `ChatView.js` is the phone placeholder, and the menu shows
Chat only on the website). It uses the core through `src/api/chatStore.js`
(own database file `chat.db`, separate from the wallet sets). The postman's
address is in `src/constants/chat.js`. Website test: `tests/web/chat.spec.js`
(runs the real postman code locally via `tests/web/chatPostman.mjs`).

