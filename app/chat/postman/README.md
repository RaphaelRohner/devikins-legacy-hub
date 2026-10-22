# chat/postman — the blind postman (Cloudflare Worker)

The server part of the Hub's chat (stage 1 of the build plan in the
claude.ai project document CHAT-DESIGN-DRAFT.md). It passes on **sealed
envelopes** between players' devices and can't open any of them.

| File | What it does |
|---|---|
| `src/postOffice.js` | All the postman's rules, in one place (sign-in, badges, nicknames, contact requests, drop codes, mailboxes, group mailboxes, clean-up). |
| `src/kleverProof.js` | Checks the wallet's signature of the sign-in text (with Klever's own code) and asks Klever's public API how many Devikins the wallet holds. |
| `../src/httpAuth.js` | (in the chat core) Every request from a device is signed with its chat key (Nostr's published "HTTP Auth" format, NIP-98). |
| `src/worker.js` | The Cloudflare part: which websites may call it, size limits, the one post office (a Durable Object with its own small SQLite database), the daily clean-up alarm. |
| `wrangler.toml` | Cloudflare settings: the name, **logs switched off**, the database. |

The automatic tests are in `../tests/postman.test.mjs` (`npm run test:chat`
in `app/`); they run the same code on a computer with a stand-in database.

## What the postman keeps – and what it doesn't

Keeps:
- a **random account number** per player, the **nickname**, and until when
  the holding was last proven (a week after signing in);
- a **fingerprint of the wallet** (a keyed hash, so one wallet = one
  account) – not the wallet address, and no NFT count. Honest limit: the
  key for the fingerprints is in the same database, and the list of
  Devikins holders is public, so whoever has the database (Cloudflare, or
  Raphael as operator) could work out which wallet belongs to which
  account. It keeps the address out of plain sight, nothing more;
- the **chat keys** (public) of each player's devices (at most 5);
- **drop codes** as fingerprints: which account each one opens – not who
  holds it;
- sealed **1:1 envelopes** until the device confirms it has them (at most
  30 days), and sealed **group envelopes** once per group for 30 days;
- **open groups** (stage 3): name, description, owner (account number),
  members (account numbers and from which post on they may read), players
  asking to join with the drop code they gave for that, and the owner's
  sealed pinned message. The postman never has a group key – as long as
  it runs this code: a postman changed to cheat could invent a member or a
  join request and be handed a key. That's one reason the code is public;
- the times of each player's contact requests (24 h), last group post,
  and a daily count of actions (2 days) – by wallet fingerprint, so leaving
  and signing in again doesn't reset the pauses and allowances.
- Times on waiting mail are rounded to the hour.

Doesn't keep: wallet addresses, NFT counts, message contents (it can't read
them), who wrote to whom in 1:1 chats (drops need only a drop code, no
signature), IP addresses, logs.

Sees while a request is being handled (and forgets): the wallet during
sign-in; who sends a contact request to which nickname; which chat key
posts to or reads which group mailbox.

Players who don't sign in for 180 days are forgotten completely.

**Removal votes (stage 4):** the postman keeps each vote (who is accused,
who opened it, the reason sealed with the group key, when) and each ballot
(who, yes/no). To vote, the wallet signs a one-time text; the postman checks
it's the player's own chat wallet and holds at least the threshold, and
keeps the **wallet address with the ballot only until the vote is counted**
(48 h): then every voter's wallet is checked again (a vote counts only if it
still holds the threshold, so Devikins moved to a second wallet count once)
and the addresses are deleted. The threshold comes from the game account's
holdings (asked once a day). Votes are counted by the postman's alarm a
few wallets per run (Cloudflare's free plan allows 50 outside requests per
run), each address deleted right after its check. Removed members are
banned from that group by wallet fingerprint (so leaving early or starting
over with the same wallet doesn't undo it) until its owner lets them back
in. Only members who were in the group when a vote started can vote in it;
the weekly limit on starting votes also stays with the wallet. Closed votes
show which ballots counted – so the group can see that a voter no longer
held the threshold at the end (accepted, 22 Oct 2026).

## Limits against misuse (all per day, so the free plan can't be used up)

- 1,500 actions per player (contact requests, drop-code changes, group posts);
- 300 envelopes per drop code (one contact can't flood a mailbox; blocking
  = removing that code);
- at most 500 envelopes waiting per device, 5 devices per player, 1 group
  post per minute, group envelopes up to 24 KB (a 2,000-character post fits),
  64 KB per 1:1 envelope;
- nicknames: look-alikes count as taken (spaces, `_ . -` ignored; 0 = O;
  1 = l = I).

Known limits, accepted for now: one NFT moved from wallet to wallet can
make several accounts (holding is checked at sign-in and weekly); the
directory lists up to 50 signed-in players with their device keys (they're
meant to be findable); Klever's API sees the wallet address at each
sign-in; a device's signed request could be repeated within one minute by
someone who intercepted it (no request today is harmful to repeat).

## The requests

| Request | Who | What |
|---|---|---|
| `GET /hello` | anyone | the postman's public key (it signs the badges) |
| `POST /signin/start` | device | a sign-in text naming the postman, with a one-time code (5 min) |
| `POST /signin/finish` | device | `{code, wallet, signature}` → account, badge (7 days) |
| `GET /me` | device | account, nickname, devices, next contact request |
| `POST /nickname` | signed-in | `{nickname}` – 2–20 letters/digits, first come first served |
| `GET /directory?q=` | signed-in | players whose nickname starts with q, with their devices |
| `POST /request` | signed-in | a contact request (sealed) to a nickname's devices only; pause 5, 10, 20 … min |
| `POST /codes` | signed-in | add/remove drop codes (removing = blocking that contact); says how many were refused |
| `POST /drop` | anyone with a drop code | sealed envelopes into that player's mailboxes |
| `POST /drop/devices` | anyone with a drop code | that player's current devices |
| `GET /mail` | device | the envelopes waiting for this device |
| `POST /mail/done` | device | `{ids}` – delete them (picked up) |
| `GET /groups` | signed-in | all open groups (name, description, owner, members; for members also activity) |
| `POST /groups/create` | signed-in | `{name, description}` – a new open group (at most 5 per player) |
| `POST /groups/join` | signed-in | `{group, code}` – ask to join; `code` is a drop code of your own |
| `GET /groups/joins?group=` | member | who is asking (nickname, devices, their code) |
| `POST /groups/admit` | member | `{group, account}` – let them in (after sealing the group key for them) |
| `GET /groups/members?group=` | member | members' nicknames and devices (to show who wrote) |
| `POST /groups/leave` | member | leave (the owner only when alone; the last one out deletes the group) |
| `POST /groups/pin`, `GET /groups/pin?group=` | owner / member | the sealed pinned message |
| `POST /proof/start` | signed-in | a one-time text for the wallet to sign before voting |
| `GET /groups/votes?group=` | member | the group's votes (open / last 7 days), threshold, may I start one; for the owner: who was removed |
| `POST /groups/vote/open` | member ≥ threshold | `{group, accused, reason (sealed), proof}` – start a removal vote (one per week) |
| `POST /groups/vote/cast` | member ≥ threshold | `{vote, yes, proof}` – vote once |
| `POST /groups/unban` | owner | let a removed member back in |
| `POST /groups/rekey` | member | after a removal: the new group key, sealed for every member's devices (the first one counts) |
| `POST /group/post` | member | one sealed group post (at most 1 per minute) |
| `GET /group/posts?group=&after=` | member | a group's posts after number N – only those from after you joined |
| `POST /leave` | device | forget this device (and the account with its last device) |

## Putting it on Cloudflare (Raphael)

Needs a Terminal on the Mac, in this folder. The first time:

1. `cd ~/Documents/"Devikins Legacy Hub"/app` and `npm install`.
2. `cd chat/postman`
3. `npx wrangler@4.148.0 login` – a browser window opens; log in to
   Cloudflare (the same account as the relay) and click **Allow**.
4. `npx wrangler@4.148.0 deploy` – prints the postman's address, e.g.
   `https://devi-postman-test.<your-name>.workers.dev`.
5. Open that address with `/hello` at the end in the browser: it shows
   the postman's key. Done.

After a change to the postman: steps 1, 2 and 4 again.

Check once in the Cloudflare dashboard: Workers & Pages → devi-postman-test
→ Settings → Observability: logs are **off**.

It stays in Cloudflare's free plan (Durable Objects with SQLite are
included); with many more players the limits are 100,000 requests and
100,000 stored rows per day.
