/**
 * fakePostman.js — a pretend postman for the automatic tests
 *
 * Behaves like the real one will (a Cloudflare Worker), in memory:
 *   - 1:1 mailboxes (one per device key): envelopes wait until collected,
 *     then are deleted; uncollected ones are deleted after 30 days.
 *   - group mailboxes: ONE stored copy per post, numbered in order and
 *     stamped with the postman's receive time; members fetch "everything
 *     after number N"; deleted after 30 days.
 * It never opens anything – it can't: everything it holds is sealed.
 */

import { DAY } from './rules.js';

export const KEEP_FOR = 30 * DAY;

export function createFakePostman({ clock = () => Date.now() } = {}) {
  const mailboxes = new Map(); // device key -> [{ envelope, at }]
  const groups = new Map(); // group id -> [{ seq, envelope, receivedAt }]
  let seq = 0;

  return {
    /** Drop a sealed 1:1 envelope into a device's mailbox. */
    drop(to, envelope) {
      if (!mailboxes.has(to)) mailboxes.set(to, []);
      mailboxes.get(to).push({ envelope, at: clock() });
    },
    /** Collect (and thereby delete) everything waiting for this device. */
    collect(deviceKey) {
      const waiting = mailboxes.get(deviceKey) || [];
      mailboxes.delete(deviceKey);
      return waiting.map((w) => w.envelope);
    },
    /** Store one copy of a group post. → its number */
    post(groupId, envelope) {
      if (!groups.has(groupId)) groups.set(groupId, []);
      seq += 1;
      groups.get(groupId).push({ seq, envelope, receivedAt: clock() });
      return seq;
    },
    /** Group posts after number `after` (0 = all still kept). */
    fetchGroup(groupId, after = 0) {
      return (groups.get(groupId) || []).filter((p) => p.seq > after);
    },
    /** The 30-day clean-up (the real postman does this with an alarm). */
    cleanUp() {
      const cutoff = clock() - KEEP_FOR;
      for (const [k, list] of mailboxes) {
        const kept = list.filter((w) => w.at >= cutoff);
        if (kept.length) mailboxes.set(k, kept); else mailboxes.delete(k);
      }
      for (const [g, list] of groups) {
        const kept = list.filter((p) => p.receivedAt >= cutoff);
        if (kept.length) groups.set(g, kept); else groups.delete(g);
      }
    },
    /** For tests: how many envelopes are stored in total. */
    storedCount() {
      let n = 0;
      for (const list of mailboxes.values()) n += list.length;
      for (const list of groups.values()) n += list.length;
      return n;
    },
  };
}
