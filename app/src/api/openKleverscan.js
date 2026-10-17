/**
 * openKleverscan.js (phone app)
 *
 * Opens a Kleverscan page inside the Hub, as a full-screen layer over the
 * current screen ("‹" or Android's Back closes it and you're back exactly
 * where you were) - Raphael, 17 Oct 2026: staying in the app gives a
 * better overall impression than jumping to the browser. App.js registers
 * the layer (KleverscanLayer); until it has, the browser is used.
 * Website version: openKleverscan.web.js (a new browser tab).
 */
import { Linking } from 'react-native';

let opener = null;

export function setKleverscanOpener(fn) {
  opener = fn;
}

export function openKleverscan(url) {
  if (opener) opener(url);
  else Linking.openURL(url);
}
