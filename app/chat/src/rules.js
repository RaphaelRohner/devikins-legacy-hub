/**
 * rules.js — the chat's agreed rules, as plain calculations
 *
 * Decided with Raphael on 21 Oct 2026 (CHAT-DESIGN-DRAFT.md). Kept apart
 * from everything else so each rule can be tested on its own and changed
 * in one place. Times are in milliseconds.
 */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Longest text message, in characters. Text only. */
export const MAX_TEXT_LENGTH = 2000;

/**
 * cleanText — what may be sent: printable text with line breaks, trimmed,
 * at most MAX_TEXT_LENGTH characters. Control characters and the invisible
 * marks that can reverse or hide words are removed. Returns '' if nothing
 * is left.
 */
export function cleanText(text) {
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // control characters except line break and tab
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    // direction marks/overrides, zero-width characters, word joiner, BOM
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')
    .trim();
  return cleaned.length > MAX_TEXT_LENGTH ? cleaned.slice(0, MAX_TEXT_LENGTH) : cleaned;
}

// --- Group posts: how many, by holdings ------------------------------------
// (Raphael, 24 Oct 2026: "that's not how people chat" - instead of one post
// every 24 h ÷ NFTs, a daily allowance that can be used in bursts.)

/**
 * Editing and deleting (29 Oct 2026, Raphael): a message or group post can
 * be edited at most MAX_EDITS times, within EDIT_WINDOW of sending it;
 * deleting is always possible. Neither counts towards the daily posts (in
 * either direction). Every Hub applies these limits itself.
 */
export const MAX_EDITS = 2;
export const EDIT_WINDOW = DAY;

/** At least this long between two posts of the same player (against flooding). */
export const MIN_POST_INTERVAL = 10 * 1000;

/** The allowance counts posts over the last 24 hours (rolling, not per calendar day). */
export const POST_WINDOW = DAY;

/**
 * Holding bands (Raphael, 27 Oct 2026). A badge travels with every group
 * post, so its Devikins count was readable by every member - and an exact
 * count (say 37) points to the few wallets holding exactly that many. Badges
 * now carry only the lower end of the band: 1 · 2–4 · 5–9 · 10–24 · 25–49 ·
 * 50+. The posting allowance is that number (a holder of 37 posts 25 a day);
 * members' Hubs keep checking it. Many wallets share each band.
 */
export const HOLDING_BANDS = [1, 2, 5, 10, 25, 50];

/** The band (its lower end) for `nfts` Devikins; 0 for none. */
export function holdingBand(nfts) {
  const n = Math.floor(Number(nfts));
  if (!Number.isFinite(n) || n < 1) return 0;
  let band = 1;
  for (const b of HOLDING_BANDS) if (n >= b) band = b;
  return band;
}

/** "1", "2–4", "5–9", "10–24", "25–49", "50+" (for the screen). */
export function bandLabel(nfts) {
  const band = holdingBand(nfts);
  if (!band) return '0';
  const next = HOLDING_BANDS[HOLDING_BANDS.indexOf(band) + 1];
  if (!next) return `${band}+`;
  return next - 1 === band ? String(band) : `${band}–${next - 1}`;
}

/**
 * postsPerDay — how many group posts someone holding `nfts` NFTs may write
 * in any 24 hours: one per NFT. 1 → 1, 65 → 65. No NFTs → 0.
 */
export function postsPerDay(nfts) {
  const n = Math.floor(Number(nfts));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * nextPostAllowedAt — when someone may post again, given the times of their
 * accepted posts (any order; only the last 24 h count) and their NFTs.
 * 0 = right away; Infinity = never (no NFTs). Used both to show "posts
 * left / next post possible" and, by every member's Hub, to drop posts that
 * came too early.
 */
export function nextPostAllowedAt(times, nfts, now = 0) {
  const allowance = postsPerDay(nfts);
  if (allowance < 1) return Infinity;
  const list = (Array.isArray(times) ? times : times === null || times === undefined ? [] : [times])
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!list.length) return 0;
  const last = list[list.length - 1];
  const reference = Math.max(now, last);
  const recent = list.filter((t) => t > reference - POST_WINDOW);
  let at = last + MIN_POST_INTERVAL;
  // Used up: the oldest of the last `allowance` posts has to leave the 24 h first.
  if (recent.length >= allowance) at = Math.max(at, recent[recent.length - allowance] + POST_WINDOW);
  return at;
}

/** How many posts are left right now (for "58 of 65 left"). */
export function postsLeft(times, nfts, now) {
  const recent = (times || []).filter((t) => Number.isFinite(t) && t > now - POST_WINDOW);
  return Math.max(0, postsPerDay(nfts) - recent.length);
}

// --- Contact requests: an exponential pause --------------------------------

export const CONTACT_FIRST_PAUSE = 5 * MINUTE;
export const CONTACT_WINDOW = DAY;

/**
 * contactRequestWait — how long until the next contact request may be
 * sent. `sentAt` = times of earlier requests. Within 24 h of the first
 * request of a series, the pause after the n-th request is 5 min × 2^(n-1)
 * (5, 10, 20, 40, 80 … min); 24 h after the series started, it starts over.
 * Returns 0 when a request may be sent now.
 */
export function contactRequestWait(sentAt, now) {
  const times = (sentAt || []).filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => a - b);
  // The current series: requests since the first one that is less than 24 h old,
  // counted from the start of a series (a series starts with a request made
  // 24 h or more after the previous series began).
  let seriesStart = null;
  let series = [];
  for (const t of times) {
    if (seriesStart === null || t - seriesStart >= CONTACT_WINDOW) {
      seriesStart = t;
      series = [t];
    } else {
      series.push(t);
    }
  }
  if (seriesStart === null || now - seriesStart >= CONTACT_WINDOW) return 0;
  const last = series[series.length - 1];
  const pause = CONTACT_FIRST_PAUSE * 2 ** (series.length - 1);
  return Math.max(0, last + pause - now);
}

// --- Removal votes ------------------------------------------------------------

/** The game account (Moonlabs), whose balance drives the voting threshold. */
export const GAME_ACCOUNT = 'klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf';
export const THRESHOLD_START = 10;
export const THRESHOLD_MAX = 50;
export const THRESHOLD_REFERENCE = 1100000;
export const THRESHOLD_STEP = 50000;

/**
 * votingThreshold — NFTs a member needs in their wallet to vote:
 * 10 + 2 for every full 50,000 the game account is below 1.1 million,
 * at most 50. 1,066,763 (21 Oct 2026) → 10; empty → 50.
 * An unknown balance (null / not a number) gives the maximum, to be safe.
 */
export function votingThreshold(gameAccountBalance) {
  const balance = Number(gameAccountBalance);
  if (gameAccountBalance === null || gameAccountBalance === undefined || !Number.isFinite(balance) || balance < 0) {
    return THRESHOLD_MAX;
  }
  const steps = Math.floor(Math.max(0, THRESHOLD_REFERENCE - balance) / THRESHOLD_STEP);
  return Math.min(THRESHOLD_MAX, THRESHOLD_START + 2 * steps);
}

export const VOTE_DURATION = 48 * HOUR;
export const VOTE_MIN_VOTES = 3;
export const VOTE_MIN_SHARE_OF_MEMBERS = 0.1;
export const VOTE_YES_SHARE = 0.6;
export const VOTE_OPEN_COOLDOWN = 7 * DAY;

/**
 * voteResult — the outcome of a removal vote once it has closed.
 *   members: number of group members when the vote opened (incl. the accused)
 *   votes:   [{ voter, yes, counts }] — `counts` = the postman confirmed the
 *            voter still held enough NFTs when the vote closed
 * Valid if at least 10 % of the members (never fewer than 3) cast a vote
 * that counts; passes with at least 60 % yes among those. Each voter counts
 * once (their last vote).
 * → { valid, passed, counted, yes, needed }
 */
export function voteResult({ members, votes, accused }) {
  const last = new Map();
  for (const v of votes || []) {
    if (!v || !v.voter || v.voter === accused) continue;
    last.set(v.voter, v);
  }
  const counted = [...last.values()].filter((v) => v.counts === true);
  const yes = counted.filter((v) => v.yes === true).length;
  const needed = Math.max(VOTE_MIN_VOTES, Math.ceil(VOTE_MIN_SHARE_OF_MEMBERS * Math.max(0, Number(members) || 0)));
  const valid = counted.length >= needed;
  const passed = valid && yes / counted.length >= VOTE_YES_SHARE;
  return { valid, passed, counted: counted.length, yes, needed };
}

/**
 * voteDecidedEarly — can the vote end before its 48 h? (Raphael, 23 Oct
 * 2026: "if everyone voted and the result is clear, why not end the vote
 * instantly?") Only when the outcome can't change any more, counting every
 * member who hasn't voted yet as a possible vote for the other side:
 *   'pass' — yes votes from at least 60 % of everyone allowed to vote, and
 *            enough votes for a valid result;
 *   'keep' — the yes share can't reach 60 % even if all the rest vote yes
 *            (no votes from more than 40 % of everyone allowed to vote), or
 *            there are too few possible voters for a valid vote at all;
 *   null   — still open.
 *   members: group members when the vote opened (incl. the accused), as for voteResult
 *   voters:  how many may vote (members since before the vote, without the accused)
 *   yes, no: votes cast so far that count
 */
export function voteDecidedEarly({ members, voters, yes, no }) {
  const needed = Math.max(VOTE_MIN_VOTES, Math.ceil(VOTE_MIN_SHARE_OF_MEMBERS * Math.max(0, Number(members) || 0)));
  const possible = Math.max(Number(voters) || 0, yes + no);
  if (possible < needed) return 'keep';
  if (yes + no >= needed && yes / possible >= VOTE_YES_SHARE) return 'pass';
  if ((possible - no) / possible < VOTE_YES_SHARE) return 'keep';
  return null;
}

/**
 * canOpenVote — a member may open at most one removal vote per week.
 * `openedAt` = times this member opened votes before.
 */
export function canOpenVote(openedAt, now) {
  return !(openedAt || []).some((t) => Number.isFinite(t) && t <= now && now - t < VOTE_OPEN_COOLDOWN);
}

/**
 * isPostingPaused — the accused can't post once at least one OTHER eligible
 * member has supported the vote (the opener alone isn't enough), until the
 * vote is decided or its 48 h are over.
 */
export function isPostingPaused({ openedAt, opener, supporters, decided }, now) {
  if (decided || !Number.isFinite(openedAt) || now - openedAt >= VOTE_DURATION) return false;
  return (supporters || []).some((s) => s && s !== opener);
}

// --- Nicknames ----------------------------------------------------------------

/**
 * nicknameKey — folds look-alike nicknames together, so nobody can pose as
 * someone else: "Devi_Fan" = "devi fan" = "DEVIFAN" = "Dev1Fan"; 0 and O
 * count the same, as do 1, l and I. The postman and every Hub compare
 * nicknames with this.
 */
export function nicknameKey(nickname) {
  return String(nickname).toLowerCase().replace(/[ _.-]+/g, '').replace(/0/g, 'o').replace(/[1l]/g, 'i');
}
