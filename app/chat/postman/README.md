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
- **linked devices** (27 Oct 2026): a player's devices (website, phone …)
  are one account. Envelopes a device sends to its player's *own* other
  devices (copies of what it wrote or changed, and once the history for a
  new device, in parts) wait like 1:1 envelopes and are deleted once picked
  up; the postman can't read them. It keeps when each device was added and
  the day it was last active (only the day, 28 Oct 2026: shown on the
  player's other devices to tell them apart), and a player can take one of
  their devices out (`/me/devices/remove`). A device not active for 60 days
  is taken out by itself (an old phone, a reinstalled app);
- **link codes** (QR codes to add a device without a wallet, 27 Oct 2026):
  only a fingerprint of the one-time code, which account it's for, and the
  Devikins count and end of the linking device's badge (so the new device
  gets the same); deleted once used or after 5 minutes. After a wallet
  sign-in, a device can ask for the same fresh badge for its player's other
  devices (`/badges/mine`) and passes them on sealed;
- **open groups** (stage 3): name, description, owner (account number),
  members (account numbers and from which post on they may read), players
  asking to join with the drop code they gave for that, the owner's
  sealed pinned message, and since when only the owner is in it. The postman never has a group key – as long as
  it runs this code: a postman changed to cheat could invent a member or a
  join request and be handed a key. That's one reason the code is public;
- the times of each player's contact requests (24 h), last group post,
  and a daily count of actions (2 days) – by wallet fingerprint, so leaving
  and signing in again doesn't reset the pauses and allowances.
- Times on waiting mail are rounded to the hour.
- **Collectors Albums** (27 Oct 2026), public on purpose: each album is
  stored under its **own album key** only – title, description, the NFTs
  shown (kind and number, with the owner's notes and sections, and a
  Devikin's picture folder), the **wallet address**
  whose NFTs they are, that wallet's signature proving it, and the owner's
  nickname only if they chose to show it. No account number, no device next
  to it. The owner's Hub publishes it again weekly; an album not refreshed
  for 60 days is deleted (at most 5,000 albums). Anyone can read them, also
  without signing in; every reader's Hub checks the signatures and whether
  the wallet still holds each NFT itself. Publishing needs a signed-in
  player (against spam), so in that moment the postman sees which device
  publishes which album (and forgets).
- **Comments on NFTs** (28 Oct 2026), public on purpose: the NFT (kind and
  number), the text, the writer's nickname and account number, when (and
  when it was last edited); and
  per comment which accounts voted "I can confirm" / "not right". Which
  comments an album's owner hid in their album (by album key). A player's
  comments and votes go with their account.
- **The album mailbox** (28 Oct 2026): conversations between a player and
  the (anonymous) owner of an album: which account talks to which album key,
  and sealed envelopes for the album key and the player's devices (it can't
  read them), kept 30 days; whether the owner blocked that player for that
  album. The owner is given the player's nickname and device keys (to
  answer), never the other way round.

Doesn't keep: wallet addresses (except the ones players put on their albums
themselves), NFT counts, message contents (it can't read
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
(48 h, or earlier once the result can't change any more: yes from 60 % of
everyone allowed to vote, or no from more than 40 %): then every voter's
wallet is checked again (a vote counts only if it still holds the threshold,
so Devikins moved to a second wallet count once) and the addresses are
deleted. If an early count finds an emptied wallet and the result is no
longer certain, the vote stays open and the addresses are kept until it ends. The threshold comes from the game account's
holdings (asked once a day). Votes are counted by the postman's alarm a
few wallets per run (Cloudflare's free plan allows 50 outside requests per
run). Removed members are
banned from that group by wallet fingerprint (so leaving early or starting
over with the same wallet doesn't undo it) until its owner lets them back
in. Only members who were in the group when a vote started can vote in it;
the weekly limit on starting votes also stays with the wallet. Closed votes
show which ballots counted – so the group can see that a voter no longer
held the threshold at the end (accepted, 22 Oct 2026).

**Badges carry bands, not counts** (27 Oct 2026): the signed note "this chat
key holds Devikins" says only the band - 1 · 2–4 · 5–9 · 10–24 · 25–49 ·
50+ (its lower end) - because it travels with every group post and an
exact count would point other players to the few wallets holding exactly
that many. The daily posting allowance is the band's lower end.

## Limits against misuse (all per day, so the free plan can't be used up)

- 1,500 actions per player (contact requests, drop-code changes, group posts;
  publishing an album counts as 10; comments: 30 a day, 2 per player on
  one NFT, 50 per NFT, 200 characters; the album mailbox: 10 new conversations a day);
- 300 envelopes per drop code (one contact can't flood a mailbox; blocking
  = removing that code);
- 3,000 envelopes per player to their own other devices (linked devices);
- at most 500 envelopes waiting per device (a full one is skipped, so the
  player's other devices still get theirs), 5 devices per player, 1 group
  post every 10 seconds (the daily allowance - posts per 24 h = Devikins - is
  checked by every member's Hub), group envelopes up to 24 KB (a 2,000-character post fits),
  64 KB per 1:1 envelope;
- groups: starting one takes as many Devikins as voting (the threshold,
  counted at the last sign-in: the badge, checked, not stored), at most 5 per
  player; a group nobody but its owner has been in for 30 days is removed
  (unless someone is waiting to be let in). The list shows the biggest
  groups first, then those with the latest post;
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
| `GET /groups` | signed-in | all open groups (name, description, owner, members; biggest first, then the latest post), what starting one takes; for the owner of a group nobody else is in: when it goes |
| `POST /groups/create` | signed-in ≥ threshold | `{name, description, badge}` – a new open group (at most 5 per player) |
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
| `POST /group/post` | member | one sealed group post (at most 1 every 10 seconds); `reaction: true` for a reaction (👍 ❤️ …: no 10-second gap, counts as an action) |
| `GET /group/posts?group=&after=` | member | a group's posts after number N – only those from after you joined |
| `POST /leave` | device | forget this device (and the account with its last device) |
| `POST /albums/publish` | signed-in | `{album}` – a Collectors Album signed with its own key, with the wallet's proof; the name on it (if any) must be the player's own nickname; a newer version replaces it |
| `POST /albums/delete` | the album's key | delete that album (the request is signed with the album's key, which only its owner's devices have) |
| `GET /albums?before=` | anyone | the albums, newest first (50 at a time): key, title, name, how many NFTs, when |
| `GET /albums/one?key=` | anyone | one album (to be checked by the reader) |
| `GET /comments?album=` | anyone | the comments on that album's NFTs, with confirm / dispute counts and whether the owner hid them there |
| `POST /comments/add` | signed-in | `{album, kind, nonce, text}` – a comment on an NFT in that album, under the player's nickname |
| `POST /comments/vote` | signed-in | `{comment, vote}` – 1 I can confirm, -1 not right, 0 take back (not on one's own) |
| `POST /comments/edit` | the writer | `{comment, text}` – change one's own comment (its votes start again) |
| `POST /comments/delete` | the writer | delete one's own comment |
| `POST /albums/hide-comment` | the album's key | `{comment, hidden}` – hide a comment in that album |
| `POST /albums/talk/send` | signed-in | `{album, items}` – sealed message to the album's owner (and copies for the player's devices) |
| `GET /albums/talk?after=` | device or album key | sealed messages for this key; for the album key also the player's nickname and devices |
| `POST /albums/talk/reply` | the album's key | `{thread, items}` – the owner's answer |
| `POST /albums/talk/block` | the album's key | `{thread, blocked}` – no more messages from that player to this album |

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
