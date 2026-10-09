/**
 * Devi Hub relay (Cloudflare Worker)
 *
 * Why this exists: the Hub website runs in a browser, and browsers refuse
 * to read Moonlabs' item-data server because that server does not say
 * "websites may read me" (no CORS header). This tiny relay fetches the
 * same data on the website's behalf and adds that permission.
 *
 * What it allows, and nothing else:
 *   GET /devikin/<number>, /weapon/<number>, /equipment/<number>
 * Anything else is refused, so nobody can misuse the relay for other sites.
 *
 * Answers are kept for a while (see CACHE_*), so popular items load fast
 * and Moonlabs' server is asked less often.
 */

const UPSTREAM = 'https://1fl8e08843.execute-api.us-east-1.amazonaws.com';

// Websites allowed to use the relay. Add your own address here if it changes.
const ALLOWED_ORIGINS = [
  'https://raphaelrohner.github.io',
  'http://localhost:8081', // the Hub's local web preview (npx expo start --web)
];

const CACHE_OK_SECONDS = 6 * 60 * 60;   // found: keep 6 hours
const CACHE_404_SECONDS = 24 * 60 * 60; // "no data for this item": keep 1 day
const PATH = /^\/(devikin|weapon|equipment)\/([0-9]{1,9})$/;

function corsHeaders(origin) {
  const h = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return new Response('Only GET is allowed', { status: 405, headers: corsHeaders(origin) });
    }
    const m = url.pathname.match(PATH);
    if (!m) {
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    const cacheKey = new Request(`${url.origin}/${m[1]}/${m[2]}`);
    const cache = caches.default;
    let res = await cache.match(cacheKey);

    if (!res) {
      let upstream;
      try {
        upstream = await fetch(`${UPSTREAM}/${m[1]}/${m[2]}`, { headers: { Accept: 'application/json' } });
      } catch (e) {
        return new Response('Upstream unreachable', { status: 502, headers: corsHeaders(origin) });
      }
      const body = await upstream.text();
      const ttl = upstream.status === 200 ? CACHE_OK_SECONDS : upstream.status === 404 ? CACHE_404_SECONDS : 0;
      res = new Response(body, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      });
      if (ttl > 0) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    return out;
  },
};
