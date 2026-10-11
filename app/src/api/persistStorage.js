/**
 * persistStorage.js (phone app)
 *
 * On the phone the app's data is already kept until the app is
 * uninstalled, so there's nothing to ask for. See persistStorage.web.js
 * for the website version.
 */

export function requestPersistentStorage() {
  return Promise.resolve(true);
}
