/**
 * worker.js — the blind postman on Cloudflare
 *
 * The front door (a Cloudflare Worker) only checks where a request comes
 * from and its size, then hands it to the ONE post office (a Durable
 * Object with its own small SQLite database), where postOffice.js decides
 * everything. A daily alarm runs the clean-up (30-day limit etc.).
 *
 * Nothing is logged: the code writes no logs, and Cloudflare's logs for
 * this Worker are switched off in wrangler.toml ([observability]).
 */

import { DurableObject } from 'cloudflare:workers';
import { createPostOffice, MAX_BODY_CHARS } from './postOffice.js';

// Websites allowed to call the postman from a browser (the Hub app on a
// phone isn't a website and doesn't need to be listed).
const ALLOWED_ORIGINS = [
  'https://raphaelrohner.github.io',
  'http://localhost:8081', // the Hub's local web preview (npx expo start --web)
];
const CLEAN_UP_EVERY = 24 * 60 * 60 * 1000;

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

/** The request's body as text, or null if it's longer than `limit` bytes. */
async function readLimited(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export class PostOffice extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.office = createPostOffice({ sql: ctx.storage.sql });
  }

  async fetch(request) {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEAN_UP_EVERY);
    }
    const result = await this.office.handle({
      method: request.method,
      url: request.url,
      bodyText: request.method === 'POST' ? await request.text() : '',
      authorization: request.headers.get('Authorization'),
    });
    return Response.json(result.body, { status: result.status });
  }

  async alarm() {
    this.office.cleanUp();
    await this.ctx.storage.setAlarm(Date.now() + CLEAN_UP_EVERY);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(403, { error: 'This website may not use the postman.' }, origin);
    if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: 'Only GET and POST.' }, origin);
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY_CHARS) return json(413, { error: 'Too big.' }, origin);
    let forward = request;
    if (request.method === 'POST') {
      // Read the body here with a size limit (a sender could leave out the
      // length), and hand the post office only what was read.
      const bodyText = await readLimited(request, MAX_BODY_CHARS);
      if (bodyText === null) return json(413, { error: 'Too big.' }, origin);
      forward = new Request(request.url, { method: 'POST', headers: request.headers, body: bodyText });
    }

    const office = env.POSTOFFICE.get(env.POSTOFFICE.idFromName('main'));
    const answer = await office.fetch(forward);
    const body = await answer.text();
    return new Response(body, {
      status: answer.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
    });
  },
};
