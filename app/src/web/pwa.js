/**
 * pwa.js - the installable website's side in the Hub (25 Nov 2026)
 *
 * Starts the offline copy (public/sw.js, the "service worker") on the
 * website and tells the Hub when a new version is ready, so UpdateNote.js
 * can show "New version available - Update" (Raphael: a note rather than a
 * silent switch, so nothing changes in the middle of what you're doing).
 *
 *   - Website only, and only where browsers allow it (https, or localhost
 *     while testing). Does nothing in the Android app.
 *   - If the browser can't do it, the website simply works as before.
 *   - applyUpdate(): the new version takes over and the page reloads once.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

const BASE = '/devikins-legacy-hub/';
let waitingWorker = null;          // the new version, ready and waiting
const listeners = new Set();       // UpdateNote(s) to tell when one is ready
let started = false;

function announce(worker) {
  waitingWorker = worker;
  for (const l of listeners) l(!!worker);
}

/** Registers the offline copy once (called by useUpdateReady). */
function start() {
  if (started || Platform.OS !== 'web' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window === 'undefined' || !window.location.pathname.startsWith(BASE)) return; // (local dev server at /)
  started = true;
  navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).then((reg) => {
    // A new version already waiting from an earlier visit.
    if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // "installed" with a controller = an UPDATE (the very first install needs no note).
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) announce(incoming);
      });
    });
    // Look for a new version now and then while the Hub stays open (every hour).
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* not available here: the website works as before */ });

  // When the new version has taken over, load it once.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

/** true once a new version is ready; starts the offline copy on first use. */
export function useUpdateReady() {
  const [ready, setReady] = useState(!!waitingWorker);
  useEffect(() => {
    start();
    listeners.add(setReady);
    return () => { listeners.delete(setReady); };
  }, []);
  return ready;
}

/** "Update" tapped: the waiting version takes over (the page then reloads, see above). */
export function applyUpdate() {
  if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}
