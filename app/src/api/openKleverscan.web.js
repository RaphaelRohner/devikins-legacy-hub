/**
 * openKleverscan.web.js (website): a Kleverscan link opens in a new
 * browser tab, as links normally do on a website. Phone app version:
 * openKleverscan.js (an in-app layer).
 */
import { Linking } from 'react-native';

export function setKleverscanOpener() {}

export function openKleverscan(url) {
  Linking.openURL(url);
}
