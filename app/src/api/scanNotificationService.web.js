/**
 * scanNotificationService.web.js
 *
 * The website version of scanNotificationService.js. When the Hub is built
 * for the browser, the build tool automatically picks this ".web.js" file
 * instead of the phone one.
 *
 * On the phone, the notification keeps a long scan alive while the app is
 * in the background (an Android feature). A browser tab has no such thing,
 * so on the website these do nothing: the scan simply runs while the tab
 * is open. Same function names as the phone file, so App.js doesn't need
 * to know the difference.
 */

export async function ensureNotificationPermission() {
  return false;
}

export async function startScanNotification() {}

export async function updateScanNotification() {}

export async function stopScanNotification() {}
