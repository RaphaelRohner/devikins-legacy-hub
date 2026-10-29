/**
 * chatUnreadWatch.js - the unread count in the Android app (Raphael, 29 Oct
 * 2026: his friend's app showed no count; the website had one, the app
 * didn't, because the app's chat only looked for mail while it was open).
 *
 * While the Hub is open and in front, but NOT on the chat screen, this looks
 * for new mail every few minutes and passes the number of unread messages
 * and group posts to setChatUnread() (src/web/chatDock.js). The 💬 handle
 * (ChatDock.js) and the ☰ menu's "Chat (3)" entry show it.
 *
 *   - On the chat screen the chat itself keeps the count up to date
 *     (ChatView's onUnreadChange, App.js), and every 10 seconds.
 *   - In the background or closed: nothing at all (no battery, no data).
 *     Notifications while the app is closed are a later idea
 *     (HUB-IDEAS-LATER.md, push notifications).
 *   - Only for a device that is signed in to the chat; otherwise the count
 *     stays 0 and nothing is asked of the postman.
 *   - The group list (who is a member) is asked of the postman at most every
 *     30 minutes; the unread numbers themselves are counted on this device.
 *
 * The website doesn't use this: its chat window runs all the time
 * (ChatDock.web.js) and counts by itself.
 */
import { AppState } from 'react-native';
import { getMessenger } from './chatStore';
import { setChatUnread, whenHubReady } from '../web/chatDock';

export const APP_MAIL_CHECK_EVERY_MS = 3 * 60 * 1000; // every 3 minutes
const GROUP_LIST_MAX_AGE_MS = 30 * 60 * 1000;

/** Counts what's unread: messages from contacts plus posts in groups I'm a member of. */
export function countUnread(contacts, groups) {
  const fromContacts = (contacts || []).reduce((n, c) => n + (c.unread || 0), 0);
  const fromGroups = (groups || []).filter((g) => g.member).reduce((n, g) => n + (g.unread || 0), 0);
  return fromContacts + fromGroups;
}

/**
 * One look: collect waiting mail (if signed in) and recount.
 * `fetchMail` false = only recount what's already on this device (e.g. right
 * after leaving the chat screen, where everything was just read).
 */
async function lookOnce({ fetchMail = true } = {}) {
  const m = await getMessenger();
  const s = await m.status();
  if (s.state !== 'ready') {
    setChatUnread(0);
    return;
  }
  if (fetchMail) await m.checkMail().catch(() => {});
  const contacts = await m.listContacts();
  let groups = [];
  try {
    groups = await m.listGroups({ maxAgeMs: GROUP_LIST_MAX_AGE_MS });
  } catch {
    // (postman not reachable: count the contacts only this time)
  }
  setChatUnread(countUnread(contacts, groups));
}

/**
 * Starts the watch (once the Hub's own database is ready). `isOnChat()` says
 * whether the chat screen is showing right now. Returns a stop function.
 */
export function startAppUnreadWatch(isOnChat) {
  let timer = null;
  let stopped = false;
  let running = false;

  const look = async (opts) => {
    if (stopped || running || isOnChat() || AppState.currentState !== 'active') return;
    running = true;
    try {
      await lookOnce(opts);
    } catch {
      // (the chat couldn't start or the postman wasn't reachable: try again next time)
    } finally {
      running = false;
    }
  };

  const cancelReady = whenHubReady(() => {
    if (stopped) return;
    look();
    timer = setInterval(() => look(), APP_MAIL_CHECK_EVERY_MS);
  });
  // Back in front: look straight away (it may have been a while).
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') look();
  });

  return {
    /** Call when the chat screen was left: recount (what was read there no longer counts). */
    afterChat: () => look({ fetchMail: false }),
    stop: () => {
      stopped = true;
      cancelReady();
      clearInterval(timer);
      sub.remove();
    },
  };
}
