/**
 * usage.js
 *
 * The anonymous user counter shown on the About screen.
 *
 * How it works, in plain words:
 *   - The first time the Hub runs (website or app), it makes up a random
 *     ID, e.g. "3f9c...". It's not linked to any wallet, name, email or
 *     device, and it's only kept on this device / in this browser.
 *   - At most once a day the Hub sends that ID, plus "web"/"android"/"ios"
 *     and the Hub version, to our relay (relay/worker.js). Nothing else -
 *     no wallet addresses, no NFTs, no names.
 *   - The relay counts how many different IDs it has seen, and the About
 *     screen shows those totals.
 *   - "Don't count me" on the About screen switches the daily hello off.
 *
 * Everything here is best-effort: if the relay can't be reached, nothing
 * else in the Hub is affected.
 */
import { Platform } from 'react-native';
import { getGlobalSetting, setGlobalSetting } from '../db/database';

const RELAY = 'https://devi-hub-relay.raphaelrohner.workers.dev';
const KEY_ID = 'usage_install_id';
const KEY_LAST_DAY = 'usage_last_ping_day';
const KEY_OPT_OUT = 'usage_opt_out';

function randomHexId() {
  let hex = '';
  for (let i = 0; i < 32; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function isUsageOptedOut() {
  return (await getGlobalSetting(KEY_OPT_OUT)) === '1';
}

export async function setUsageOptOut(optedOut) {
  await setGlobalSetting(KEY_OPT_OUT, optedOut ? '1' : '0');
}

/** Says "hello" to the counter, at most once a day. Never throws. */
export async function pingOncePerDay(appVersion) {
  try {
    if (await isUsageOptedOut()) return;
    const today = todayUtc();
    if ((await getGlobalSetting(KEY_LAST_DAY)) === today) return;
    let id = await getGlobalSetting(KEY_ID);
    if (!id || !/^[0-9a-f]{32}$/.test(id)) {
      id = randomHexId();
      await setGlobalSetting(KEY_ID, id);
    }
    const response = await fetch(`${RELAY}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, platform: Platform.OS, version: String(appVersion || '') }),
    });
    if (response.ok) await setGlobalSetting(KEY_LAST_DAY, today);
  } catch (e) {
    // Offline or relay not reachable - simply try again next start.
  }
}

/**
 * The totals for the About screen, or null if they can't be loaded:
 * { total, last30Days, today, last30DaysByPlatform: { web, android, ios } }
 */
export async function fetchUsageStats() {
  try {
    const response = await fetch(`${RELAY}/stats`);
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}
