/*
 * sw.js — the Hub's offline copy (installable website, 25 Nov 2026)
 * ==================================================================
 *
 * A "service worker": a small script the browser keeps running for the Hub
 * in the background. It keeps a full copy of the website (the page, its
 * program files, fonts and icons) on this device, so an installed Hub –
 * and the website in this browser – still starts if the Hub's website is
 * ever offline or gone (feedback by jenniferseward, Klever forum).
 *
 * What it does NOT touch: anything from other websites (Klever, Moonlabs'
 * pictures and data, the chat's postman). Those requests go straight to
 * the internet as before; the Hub's own database keeps your collection.
 *
 * Updates (Raphael, 25 Nov 2026: "with a notification"): every website
 * build writes its own build number into this file (BUILD below, set by
 * the Deploy workflow). The browser notices the changed file, prepares the
 * new copy in the background and WAITS. The Hub then shows "New version
 * available – Update"; only when you tap it does the new copy take over
 * (message SKIP_WAITING) and the page reloads. Until then the old copy
 * keeps working, so nothing changes in the middle of what you're doing.
 *
 * Kept simple on purpose: no extra library, plain browser features.
 */

const BUILD = '__BUILD__'; // replaced by the Deploy workflow with the commit id
const CACHE = `devi-hub-${BUILD}`;
// Where the Hub lives: /devikins-legacy-hub/ on GitHub Pages (this file's folder).
const BASE = new URL('./', self.location).pathname;
const START = [BASE, `${BASE}manifest.webmanifest`, `${BASE}favicon.ico`, `${BASE}icon-192.png`, `${BASE}icon-512.png`];

/** The program files the page loads (scripts, styles), read from the page itself. */
function filesIn(html) {
  const found = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(m[1], self.location);
    if (url.origin === self.location.origin && url.pathname.startsWith(BASE)) found.add(url.pathname);
  }
  return [...found];
}

// 1. A new version arrives: copy the page and everything it needs, then wait.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const page = await fetch(BASE, { cache: 'reload' });
    if (!page.ok) throw new Error('The Hub page could not be loaded.');
    await cache.put(BASE, page.clone());
    const html = await page.text();
    await cache.addAll([...new Set([...START.slice(1), ...filesIn(html)])].map((u) => new Request(u, { cache: 'reload' })));
  })());
  // No skipWaiting() here: the new version waits until you tap "Update".
});

// 2. It takes over: remove older copies.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('devi-hub-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// "Update" tapped in the Hub (src/web/pwa.js).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// 3. Serving: the Hub's own files from the copy; everything else untouched.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return; // other websites: not ours
  if (request.mode === 'navigate') {
    // Any Hub address opens the Hub page from the copy (the Hub picks the screen itself).
    event.respondWith((async () => (await caches.match(BASE, { cacheName: CACHE })) || fetch(request))());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request, { cacheName: CACHE });
    if (cached) return cached;
    const response = await fetch(request);
    // Files loaded later (pictures in the Hub's assets, fonts) join the copy the first time.
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  })());
});
