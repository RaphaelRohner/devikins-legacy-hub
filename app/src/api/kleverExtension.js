/**
 * kleverExtension.js
 *
 * Phone version of kleverExtension.web.js. The Klever browser extension
 * only exists in desktop browsers, so on the phone these simply report
 * "not available" and the buttons that use them stay hidden.
 */

export function isExtensionAvailable() {
  return false;
}

export async function connectExtension() {
  throw new Error('The Klever browser extension is only available on the website.');
}

export async function sendKlvWithExtension() {
  throw new Error('The Klever browser extension is only available on the website.');
}
