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
 *   - The Hub keeps a few extra "pages" in the browser's history (added
 *     whenever you click or type on the page).
 *   - When back is pressed, one extra page is used up, and the same
 *     Back handling as on the phone runs (newest screen first).
 *   - If there was nothing left to close (you're on the main list), the
 *     browser goes back for real and leaves the Hub, like any website.
 *   - An open message box is closed first, like pressing Esc.
 *
 * Loaded once at start-up from index.js; does nothing on the phone.
 */

import { BackHandler, Platform } from 'react-native';

const MARK = 'devikinsHubBack';
// How many extra pages to keep ready, so several Back presses in a row
// (menu, then NFT, then Wallets...) all stay inside the Hub.
const RESERVE = 3;

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

  // Each history page the Hub owns is numbered: 0 is the Hub itself, 1..3
  // are the extra pages. `position` is the one the browser is on now.
  function numberOf(state) {
    return state && state[MARK] ? state.n : 0;
  }
  let position = numberOf(window.history.state);
  try {
    window.history.replaceState({ ...(window.history.state || {}), [MARK]: true, n: position }, '');
  } catch (e) {
    // ignore
  }

  // Chrome ignores extra pages a website adds before the visitor has
  // clicked or typed anything (it protects people from sites that "trap"
  // the back button) - seen 12 Oct 2026 after a Mac restart reopened the
  // Hub. So the extra pages are only added right when the visitor clicks
  // or types, which Chrome accepts.
  function topUp(event) {
    if (event && !event.isTrusted) return; // only real clicks and key presses
    try {
      while (position < RESERVE) {
        position += 1;
        window.history.pushState({ [MARK]: true, n: position }, '');
      }
    } catch (e) {
      // Some browsers limit history changes; Back then simply leaves the Hub.
    }
  }
  window.addEventListener('pointerdown', topUp, { capture: true, passive: true });
  window.addEventListener('keydown', topUp, { capture: true, passive: true });

  window.addEventListener('popstate', (event) => {
    const now = numberOf(event.state);
    if (now >= position) {
      // Forward button (or nothing changed): just remember where we are.
      position = now;
      return;
    }
    position = now;

    // A message box is open: close it like Esc would.
    if (document.querySelector('[data-hub-dialog]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
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
      if (handled) return;
    }

    // Nothing left to close inside the Hub: leave it like a normal website
    // (skipping the Hub's remaining extra pages in one go).
    window.history.go(-(position + 1));
  });
}

if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history) {
  install();
}
