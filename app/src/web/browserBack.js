/**
 * browserBack.js
 *
 * On the phone, the Back button (or gesture) moves around inside the Hub:
 * it closes the menu, closes an open NFT, returns from Wallets to the list,
 * and so on. Each screen says what Back should do there, through React
 * Native's BackHandler.
 *
 * In the browser version of React Native, BackHandler does nothing, so the
 * browser's own back button used to leave the Hub straight away (Raphael
 * noticed it on 12 Oct 2026).
 *
 * This file makes the browser's back button work like the phone's:
 *   - The Hub keeps one extra "page" in the browser's history.
 *   - When back is pressed, that extra page is used up, and the same
 *     Back handling as on the phone runs (newest screen first).
 *   - If something in the Hub was closed, the extra page is put back,
 *     ready for the next press.
 *   - If there was nothing left to close (you're on the main list), the
 *     browser goes back for real and leaves the Hub, like any website.
 *   - An open message box is closed first, like pressing Esc.
 *
 * Loaded once at start-up from index.js; does nothing on the phone.
 */

import { BackHandler, Platform } from 'react-native';

const MARK = 'devikinsHubBack';

function install() {
  const listeners = [];

  BackHandler.addEventListener = (eventName, handler) => {
    if (eventName !== 'hardwareBackPress' || typeof handler !== 'function') return { remove() {} };
    listeners.push(handler);
    return {
      remove() {
        const i = listeners.lastIndexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  };
  BackHandler.removeEventListener = (eventName, handler) => {
    const i = listeners.lastIndexOf(handler);
    if (i >= 0) listeners.splice(i, 1);
  };

  function addExtraPage() {
    try {
      window.history.pushState({ [MARK]: true }, '');
    } catch (e) {
      // Some browsers limit history changes; Back then simply leaves the Hub.
    }
  }

  // After a page reload the extra page is usually still there.
  if (!window.history.state || !window.history.state[MARK]) addExtraPage();

  window.addEventListener('popstate', (event) => {
    // Moving forward onto our own extra page again: nothing to do.
    if (event.state && event.state[MARK]) return;

    // A message box is open: close it like Esc would.
    const dialog = document.querySelector('[data-hub-dialog]');
    if (dialog) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      addExtraPage();
      return;
    }

    // The newest screen gets the first chance, same as on the phone.
    for (let i = listeners.length - 1; i >= 0; i -= 1) {
      let handled = false;
      try {
        handled = listeners[i]() === true;
      } catch (e) {
        handled = false;
      }
      if (handled) {
        addExtraPage();
        return;
      }
    }

    // Nothing left to close inside the Hub: leave it like a normal website.
    window.history.back();
  });
}

if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history) {
  install();
}
