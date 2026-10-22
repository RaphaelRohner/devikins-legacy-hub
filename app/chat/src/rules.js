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

// --- Group posts: how often, by holdings -----------------------------------

/** Nobody posts in a group more often than this (against accidental flooding). */
export const MIN_POST_INTERVAL = MINUTE;

/**
 * postInterval — the time between two posts in an open group for someone
 * holding `nfts` NFTs: 24 h ÷ NFTs, but never less than one minute.
 * 1 → 24 h, 2 → 12 h, 24 → 1 h, 100 → 14.4 min, 2000 → 1 min.
 * No NFTs (or not a number) → Infinity: can't post.
 */
export function postInterval(nfts) {
  const n = Math.floor(Number(nfts));
  if (!Number.isFinite(n) || n < 1) return Infinity;
  return Math.max(MIN_POST_INTERVAL, Math.round(DAY / n));
}

/**
 * nextPostAllowedAt — when someone may post again, given when their last
 * post was accepted (null = never). Used both to show "Next post possible
 * in …" and, by every member's Hub, to drop posts that came too early.
 */
export function nextPostAllowedAt(lastAcceptedAt, nfts) {
  if (lastAcceptedAt === null || lastAcceptedAt === undefined) return 0;
  return lastAcceptedAt + postInterval(nfts);
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
