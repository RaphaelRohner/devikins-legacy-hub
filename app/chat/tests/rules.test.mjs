/*
 * rules.test.mjs — the agreed rules (CHAT-DESIGN-DRAFT.md, 21 Oct 2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  postInterval, nextPostAllowedAt, contactRequestWait, votingThreshold, voteResult, canOpenVote, isPostingPaused,
  MINUTE, HOUR, DAY,
} from '../src/rules.js';

test('posting in open groups: 24 h ÷ NFTs, at most once a minute, nothing without NFTs', () => {
  assert.equal(postInterval(1), DAY);
  assert.equal(postInterval(2), 12 * HOUR);
  assert.equal(postInterval(3), 8 * HOUR);
  assert.equal(postInterval(24), HOUR);
  assert.equal(postInterval(50), Math.round(DAY / 50)); // ~29 min
  assert.equal(postInterval(100), Math.round(DAY / 100)); // ~14 min
  assert.equal(postInterval(5000), MINUTE);
  assert.equal(postInterval(0), Infinity);
  assert.equal(postInterval(undefined), Infinity);
  assert.equal(nextPostAllowedAt(null, 1), 0);
  assert.equal(nextPostAllowedAt(1000, 2), 1000 + 12 * HOUR);
});

test('contact requests: 5, 10, 20, 40 … minutes apart, about 9 in the first day, then a fresh start', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(contactRequestWait([], t0), 0);
  assert.equal(contactRequestWait([t0], t0), 5 * MINUTE);
  assert.equal(contactRequestWait([t0, t0 + 5 * MINUTE], t0 + 5 * MINUTE), 10 * MINUTE);
  // send as soon as allowed, and count how many fit into 24 h
  const sent = [];
  let now = t0;
  while (now - t0 < DAY) {
    const wait = contactRequestWait(sent, now);
    if (wait > 0) { now += wait; continue; }
    if (now - t0 >= DAY) break;
    sent.push(now);
  }
  assert.equal(sent.length, 9);
  // 24 h after the first request of the series: a new series, no wait
  assert.equal(contactRequestWait(sent, t0 + DAY), 0);
  assert.equal(contactRequestWait([...sent, t0 + DAY], t0 + DAY), 5 * MINUTE);
});

test('voting threshold follows the game account: 10 today, +2 per 50,000 fewer, at most 50', () => {
  assert.equal(votingThreshold(1_066_763), 10); // 21 Oct 2026
  assert.equal(votingThreshold(1_100_000), 10);
  assert.equal(votingThreshold(1_050_000), 12);
  assert.equal(votingThreshold(1_000_001), 12);
  assert.equal(votingThreshold(1_000_000), 14);
  assert.equal(votingThreshold(500_000), 34);
  assert.equal(votingThreshold(0), 50); // would be 54, capped
  assert.equal(votingThreshold(2_000_000), 10); // more than the reference: never below 10
  assert.equal(votingThreshold(null), 50); // unknown: be strict
  assert.equal(votingThreshold('oops'), 50);
});

test('a removal vote: at least 3 votes / 10 % of members, 60 % yes; the accused and invalid votes don\'t count', () => {
  const v = (voter, yes, counts = true) => ({ voter, yes, counts });
  assert.deepEqual(voteResult({ members: 8, accused: 'x', votes: [v('a', true), v('b', true)] }), { valid: false, passed: false, counted: 2, yes: 2, needed: 3 });
  assert.equal(voteResult({ members: 8, accused: 'x', votes: [v('a', true), v('b', true), v('c', false)] }).passed, true); // 67 %
  assert.equal(voteResult({ members: 8, accused: 'x', votes: [v('a', true), v('b', false), v('c', false)] }).passed, false);
  // 10 % of 100 members = 10 votes needed
  const nine = 'abcdefghi'.split('').map((c) => v(c, true));
  assert.equal(voteResult({ members: 100, accused: 'x', votes: nine }).valid, false);
  assert.equal(voteResult({ members: 100, accused: 'x', votes: [...nine, v('j', true)] }).passed, true);
  // NFTs moved away before the close (postman says it doesn't count), the accused, voting twice
  assert.equal(voteResult({ members: 8, accused: 'x', votes: [v('a', true), v('b', true, false), v('x', false), v('c', true)] }).counted, 2);
  assert.equal(voteResult({ members: 8, accused: 'x', votes: [v('a', true), v('a', false), v('b', true), v('c', true)] }).yes, 2); // last vote counts
  // exactly 60 % passes
  assert.equal(voteResult({ members: 10, accused: 'x', votes: [v('a', true), v('b', true), v('c', true), v('d', false), v('e', false)] }).passed, true);
});

test('one vote per week per member; posting pauses only once a second member supports it', () => {
  const now = 1_000_000_000_000;
  assert.equal(canOpenVote([], now), true);
  assert.equal(canOpenVote([now - 6 * DAY], now), false);
  assert.equal(canOpenVote([now - 7 * DAY], now), true);
  const vote = { openedAt: now, opener: 'a', supporters: ['a'], decided: false };
  assert.equal(isPostingPaused(vote, now + HOUR), false);
  assert.equal(isPostingPaused({ ...vote, supporters: ['a', 'b'] }, now + HOUR), true);
  assert.equal(isPostingPaused({ ...vote, supporters: ['a', 'b'] }, now + 48 * HOUR), false);
  assert.equal(isPostingPaused({ ...vote, supporters: ['a', 'b'], decided: true }, now + HOUR), false);
});
