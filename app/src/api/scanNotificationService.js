/**
 * scanNotificationService.js
 *
 * Wraps react-native-notify-kit (a maintained, drop-in-compatible fork
 * of the now-archived @notifee/react-native - same API, same import
 * shape, just a different package name) to keep a wallet scan alive and
 * visible while the app is backgrounded.
 *
 * Why this exists: without it, a scan that's running while you switch
 * away to another app can still get killed outright by Android after
 * a while in the background (see NOTES.md's "Background scan survives
 * being backgrounded" entry) - normal JS execution isn't enough to stop
 * that, only a proper Android foreground service (with its own ongoing
 * notification) tells Android "this is active work, don't reclaim it".
 *
 * Everything here is best-effort: if the user declines the notification
 * permission, or anything about the service fails to start, the scan
 * still runs exactly as it always has (see App.js's handleFetchPress) -
 * this module just adds background-survival on top when it can.
 */
import notifee, {
  AndroidColor,
  AndroidForegroundServiceType,
  AndroidImportance,
  AuthorizationStatus,
} from 'react-native-notify-kit';

const CHANNEL_ID = 'scan-progress';
const NOTIFICATION_ID = 'devikins-scan';

let channelReady = false;

async function ensureChannel() {
  if (channelReady) return;
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Scan progress',
    // LOW = shows in the notification shade without a sound or a
    // heads-up popup every time it updates - this fires on every
    // progress tick, so anything louder would be constant noise.
    importance: AndroidImportance.LOW,
  });
  channelReady = true;
}

/**
 * Asks for Android 13+'s notification permission if it hasn't been
 * granted (or denied) yet. Safe to call every time a scan starts -
 * notify-kit only actually shows the system dialog the first time;
 * after that it just reports back the existing answer.
 *
 * Returns true if notifications are allowed, false otherwise. A false
 * result isn't an error - it just means startScanNotification() below
 * won't be able to protect the scan, and the caller should carry on
 * without it rather than blocking the user's fetch over this.
 */
export async function ensureNotificationPermission() {
  try {
    const settings = await notifee.requestPermission();
    return settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
  } catch (err) {
    return false;
  }
}

/**
 * Starts the Android foreground service and shows its persistent
 * "scan running" notification. Call this once, right before a scan
 * begins, only after ensureNotificationPermission() resolved true.
 */
export async function startScanNotification() {
  await ensureChannel();
  await notifee.displayNotification({
    id: NOTIFICATION_ID,
    title: 'Devikins scan running',
    body: 'Getting started...',
    android: {
      channelId: CHANNEL_ID,
      asForegroundService: true,
      // Matches the "dataSync" foregroundServiceType declared via the
      // react-native-notify-kit config plugin in app.json - Android 14+
      // requires the two to agree.
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
      ongoing: true,
      // Only the very first display of this notification ID should
      // make a sound/vibrate - every update after that (as progress
      // ticks up) should update quietly in place.
      onlyAlertOnce: true,
      progress: { indeterminate: true },
      color: AndroidColor.BLUE,
      colorized: true,
    },
  });
}

/**
 * Updates the running notification's text and progress bar. Safe to
 * call often (e.g. on every fetchAllForWallets onProgress tick) - it
 * just replaces the same notification ID in place rather than creating
 * new ones. If the notification/service was never started (e.g.
 * permission was declined), this quietly does nothing.
 */
export async function updateScanNotification(progress) {
  if (!progress) return;
  try {
    const hasTotal = typeof progress.total === 'number' && progress.total > 0;
    const body = progress.label
      ? hasTotal
        ? `${progress.label}: ${progress.completed}/${progress.total}`
        : progress.label
      : 'Fetching your NFTs...';

    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Devikins scan running',
      body,
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        ongoing: true,
        onlyAlertOnce: true,
        progress: hasTotal
          ? { max: progress.total, current: Math.min(progress.completed, progress.total) }
          : { indeterminate: true },
        color: AndroidColor.BLUE,
        colorized: true,
      },
    });
  } catch (err) {
    // Best-effort only - a failed notification update should never
    // interrupt the actual scan.
  }
}

/**
 * Stops the foreground service and removes its notification. Always
 * safe to call, including when the service was never started (e.g.
 * permission was declined) - notify-kit just no-ops in that case. Call
 * this from handleFetchPress's `finally` block so it always runs,
 * whether the scan finished, was cancelled, or errored out.
 */
export async function stopScanNotification() {
  try {
    await notifee.stopForegroundService();
  } catch (err) {
    // Nothing left to clean up if this fails - ignore.
  }
}
