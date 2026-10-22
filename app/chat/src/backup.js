/**
 * backup.js — locking the chat backup with a password
 *
 * The chat part of a Hub backup holds the chat key (it opens your
 * messages) and your message history, so it is locked with a password
 * before it goes into the backup file. Only the browser's own built-in
 * cryptography is used (Web Crypto, the same in every modern browser):
 *   - the password is stretched with PBKDF2-SHA-256, 600,000 rounds and a
 *     random salt (so guessing passwords is slow), into a 256-bit key;
 *   - the data is locked with AES-256-GCM (which also notices any change).
 * Without the password nobody can open it – including Raphael. A forgotten
 * password can't be recovered; the wallet sets in the same backup are not
 * affected (they aren't locked).
 */

export const BACKUP_FORMAT = 'devi-hub-chat-backup';
export const PBKDF2_ROUNDS = 600000;
export const MIN_PASSWORD_LENGTH = 8;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser can\'t lock the chat backup (no Web Crypto).');
  return s;
};

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function keyFrom(password, salt, rounds) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Locks `data` (any JSON-able object) with `password`. → a plain object to store as JSON. */
export async function lockBackup(data, password, { rounds = PBKDF2_ROUNDS } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, rounds);
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', rounds, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    data: toBase64(sealed),
  };
}

/** Opens a locked backup. Throws "Wrong password …" if it doesn't open. */
export async function unlockBackup(locked, password) {
  if (!locked || locked.format !== BACKUP_FORMAT || locked.version !== 1 || locked.kdf?.name !== 'PBKDF2'
      || locked.cipher?.name !== 'AES-GCM' || !Number.isInteger(locked.kdf.rounds) || locked.kdf.rounds < 100000
      || locked.kdf.rounds > 10000000) {
    throw new Error("That isn't a chat backup this Hub can read.");
  }
  const key = await keyFrom(String(password ?? ''), fromBase64(locked.kdf.salt), locked.kdf.rounds);
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(locked.cipher.iv) }, key, fromBase64(locked.data));
  } catch {
    const e = new Error('Wrong password (or the chat backup is damaged).');
    e.wrongPassword = true;
    throw e;
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
