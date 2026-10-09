import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';
import notifee from 'react-native-notify-kit';
import './src/web/alertForWeb'; // website only: makes pop-up messages work in the browser

import App from './App';

// Registers the foreground-service worker used to keep a wallet scan
// alive while the app is backgrounded (see
// src/api/scanNotificationService.js). This has to happen here, at the
// top level, before the app itself even starts - not inside a
// component - per react-native-notify-kit's own setup guide. The
// promise below is intentionally never resolved on its own; the
// service stays running until scanNotificationService.js's
// stopScanNotification() calls notifee.stopForegroundService()
// directly, once a scan finishes, is cancelled, or errors out.
// (Phone only - a browser has no foreground services.)
if (Platform.OS !== 'web') {
  notifee.registerForegroundService(() => {
    return new Promise(() => {});
  });
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
