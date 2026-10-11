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
 *   POST /ping and GET /stats - the anonymous user counter (see below)
 * Anything else is refused, so nobody can misuse the relay for other sites.
 *
 * USER COUNTER (added 10 Oct 2026). Each Hub (website or app) makes up a
 * random ID the first time it runs - not linked to any wallet, name or
 * device - and says "hello" with it each time it's opened (only once a
 * wallet has been added): POST /ping with {id, platform, version}. The
 * counter keeps one row per ID per day in a small Cloudflare D1 database
 * (bound to this Worker as "DB"), with how many times that Hub was opened
 * that day ("visits", added 11 Oct 2026); it stores no IP address and
 * nothing else. GET /stats answers with totals for the About screen:
 * people (different IDs) and visits, for today / 7 days / 30 days / ever. Counts are approximate by nature (someone clearing their
 * browser shows up as a new user).
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
const STATS_CACHE_SECONDS = 10 * 60; // the About screen's numbers refresh every 10 minutes
const PLATFORMS = ['web', 'android', 'ios'];
const MAX_VISITS_PER_DAY = 200; // per Hub; stops one stuck or misbehaving Hub from inflating the numbers

// The "visits" column was added after the counter went live. The first
// request after a deploy adds it to the existing table (all earlier rows
// count as 1 visit each); afterwards this is a no-op.
let visitsColumnReady = false;
async function ensureVisitsColumn(env) {
  if (visitsColumnReady) return;
  try {
    await env.DB.prepare('ALTER TABLE pings ADD COLUMN visits INTEGER NOT NULL DEFAULT 1').run();
  } catch (e) {
    // "duplicate column" - it's already there.
  }
  visitsColumnReady = true;
}

function corsHeaders(origin) {
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
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
    if (url.pathname === '/ping' && request.method === 'POST') {
      return handlePing(request, env, origin);
    }
    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(env, ctx, url, origin);
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

function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...extra },
  });
}

async function handlePing(request, env, origin) {
  if (!env.DB) return json({ error: 'counter not set up' }, 503, origin);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return json({ error: 'bad request' }, 400, origin);
  }
  const id = String(body?.id || '');
  const platform = String(body?.platform || '');
  const version = String(body?.version || '').slice(0, 20);
  if (!/^[0-9a-f]{32}$/.test(id) || !PLATFORMS.includes(platform) || !/^[0-9A-Za-z.\-]{0,20}$/.test(version)) {
    return json({ error: 'bad request' }, 400, origin);
  }
  const day = new Date().toISOString().slice(0, 10); // UTC date, e.g. 2026-10-10
  await ensureVisitsColumn(env);
  await env.DB.prepare(
    `INSERT INTO pings (id, day, platform, version, visits) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (id, day) DO UPDATE SET visits = MIN(visits + 1, ${MAX_VISITS_PER_DAY}), version = excluded.version`
  )
    .bind(id, day, platform, version)
    .run();
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

async function handleStats(env, ctx, url, origin) {
  if (!env.DB) return json({ error: 'counter not set up' }, 503, origin);
  const cacheKey = new Request(`${url.origin}/stats`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const out = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    return out;
  }
  const since30 = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  await ensureVisitsColumn(env);
  // n = people (different IDs), v = visits (times the Hub was opened)
  const [total, last30, last7, todayRow, byPlatform] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT id) AS n, SUM(visits) AS v FROM pings').first(),
    env.DB.prepare('SELECT COUNT(DISTINCT id) AS n, SUM(visits) AS v FROM pings WHERE day >= ?').bind(since30).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT id) AS n, SUM(visits) AS v FROM pings WHERE day >= ?').bind(since7).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT id) AS n, SUM(visits) AS v FROM pings WHERE day = ?').bind(today).first(),
    env.DB.prepare('SELECT platform, COUNT(DISTINCT id) AS n FROM pings WHERE day >= ? GROUP BY platform').bind(since30).all(),
  ]);
  const data = {
    total: total?.n ?? 0,
    last30Days: last30?.n ?? 0,
    last7Days: last7?.n ?? 0,
    visits: {
      today: todayRow?.v ?? 0,
      last7Days: last7?.v ?? 0,
      last30Days: last30?.v ?? 0,
      total: total?.v ?? 0,
    },
    today: todayRow?.n ?? 0,
    last30DaysByPlatform: Object.fromEntries((byPlatform?.results || []).map((r) => [r.platform, r.n])),
    updatedAt: new Date().toISOString(),
  };
  const res = json(data, 200, '', { 'Cache-Control': `public, max-age=${STATS_CACHE_SECONDS}` });
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  return out;
}
