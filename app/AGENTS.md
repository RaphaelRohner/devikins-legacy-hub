# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Signing (KLV Signer)

The Hub never stores or handles private keys. Anything that needs a
signature goes through the separate KLV Signer app (`src/api/klvSigner.js`,
rules in the KLV Signer project's `SIGNER-PROTOCOL.md`). Don't add key
import/storage to the Hub. Transactions are testnet-only for now
(`src/api/kleverTx.js`).

## Chat (stage 0 since 21 Oct 2026)

The chat core lives in `chat/` (plain JavaScript, no screens, so it can move
to another app; see `chat/README.md` and the design in the KLV Signer
project's CHAT-DESIGN-DRAFT.md). It holds **chat keys**: keys made only for
the chat, one per device. They are NOT wallet keys and can't move NFTs or
coins, so the rule above still holds: no wallet keys in the Hub. Never use
a wallet key as a chat key. No home-made encryption: sealing and signatures
come from `nostr-tools` (Nostr's published NIP-44 / NIP-59 formats).
Tests: `npm run test:chat`.

