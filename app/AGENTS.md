# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Signing (KLV Signer)

The Hub never stores or handles private keys. Anything that needs a
signature goes through the separate KLV Signer app (`src/api/klvSigner.js`,
rules in the KLV Signer project's `SIGNER-PROTOCOL.md`). Don't add key
import/storage to the Hub. Transactions are testnet-only for now
(`src/api/kleverTx.js`).
