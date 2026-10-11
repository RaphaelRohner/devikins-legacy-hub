/**
 * persistStorage.web.js (website)
 *
 * Browsers may clear a website's saved data when the computer runs low on
 * space (and Safari clears it after about 7 days without a visit). Asking
 * for "persistent storage" tells the browser: please keep this site's data
 * unless the person deletes it themselves.
 *
 * Browsers only grant this after a real user action, so it's called when
 * someone adds a wallet. Chrome and Edge decide quietly; Firefox may show a
 * small "allow this site to store data" question. If it's refused, nothing
 * breaks - the data is just kept the normal way, and the export is the
 * safety net.
 */

export async function requestPersistentStorage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}
