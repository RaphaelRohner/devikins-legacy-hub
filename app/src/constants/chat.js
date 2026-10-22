/**
 * chat.js — the Hub's chat settings.
 *
 * POSTMAN_URL: the blind postman (app/chat/postman), a Cloudflare Worker on
 * Raphael's account. "devi-postman-test" while the chat is being tested;
 * the real one gets its own name later (and a fresh start).
 */
export const POSTMAN_URL = 'https://devi-postman-test.raphaelrohner.workers.dev';

/**
 * How often the chat screen looks for new mail while it's open. (The
 * automatic website tests set a shorter time through
 * window.__HUB_CHAT_MAIL_MS, so they don't wait 10 seconds each time.)
 */
export const MAIL_CHECK_EVERY_MS = (typeof window !== 'undefined' && Number(window.__HUB_CHAT_MAIL_MS)) || 10_000;
