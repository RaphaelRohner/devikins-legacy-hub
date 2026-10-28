# Security – Devikins Legacy Hub

The Hub is a fan-made companion for Devikins players: website and Android
app. This page says how to report a security problem, and what the Hub does
and doesn't do with your data.

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private reporting instead:
this repository's **Security and quality** tab → **Report a vulnerability**.
Only the maintainer sees the report until a fix is out.

For problems with keys, signing or the approval screens, report to the
**KLV Signer** instead: https://github.com/RaphaelRohner/klv-signer (its
SECURITY.md covers how keys are protected).

## What the Hub does with your data

- **No keys, no passwords.** The Hub only ever asks for public wallet
  addresses (`klv1…`). It can't move, sell or sign anything by itself.
- **Signing happens elsewhere.** The chat's sign-in and votes are signatures
  of a short text, made in the Klever browser extension (website) or the
  KLV Signer app (Android). They are not transactions and cost nothing. The
  Hub checks each signature before using it.
- **Your data stays on your device:** wallet lists, NFT details, the
  Withdrawals list and the chat history are stored in your browser or the
  app. Backups ("Export all sets") are files you keep; the chat part of a
  backup is locked with a password you choose.
- **Public data is read directly** from Klever's servers (wallet contents,
  where an NFT is) and Moonlabs' item data, through a small relay
  (`relay/worker.js`) because Moonlabs' server doesn't allow websites to
  read it. The relay only passes item data through, and keeps an anonymous
  user counter: a random ID per Hub, no wallet, no IP address.
- **The chat is end-to-end encrypted.** Messages are sealed on your device
  and opened only on the receiver's. The "postman" that passes them on (a
  Cloudflare Worker, `app/chat/postman`) can't read them, keeps no IP
  addresses or logs, and doesn't store wallet addresses (only those of
  voters, briefly, until a vote is counted). Its README lists exactly what
  it keeps, including its honest limits.
- **Collectors Albums are public.** The album screens don't show the wallet
  or the NFTs' numbers (against casual looking-up), but the album's data
  contains the wallet address, so someone determined can find it and look
  it up on Kleverscan; the Hub says so before you publish. It isn't linked to your chat nickname unless
  you switch that on. Every viewer's Hub checks the album's signatures and
  whether each NFT is still in the wallet. Comments on NFTs are public and
  show the writer's chat nickname. Messages to an album's owner are sealed
  like the chat; the postman knows which player writes to which album, but
  not who owns it.

## What we check

- Automated website and chat tests on every push.
- GitHub's CodeQL code scanning, secret scanning and Dependabot alerts.
- The Android app's only signing partner is the official KLV Signer: the Hub
  checks the Signer's signing certificate with Android before every request.

## Limits

- Built and tested by one person, with AI-assisted reviews; no independent
  security audit.
- On a phone or computer with harmful software, no app can fully protect
  you. Keep your recovery words offline and never type them into a website
  or chat.
- Nobody from the Hub will ever ask for your recovery words or password.
