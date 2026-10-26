/**
 * setupRandom.js - secure random numbers for the chat's encryption, in the
 * Android app too (26 Oct 2026).
 *
 * The chat (app/chat) makes keys and one-time numbers with
 * crypto.getRandomValues, which every browser has but an Android app
 * doesn't. This plugs in the phone's own secure generator (expo-crypto),
 * the same way the KLV Signer does. Imported first thing in index.js.
 * In a browser it does nothing: crypto.getRandomValues is already there.
 * Below: a stand-in TextDecoder, in case the app's engine has none.
 */
import * as ExpoCrypto from 'expo-crypto';

if (typeof globalThis.crypto !== 'object' || globalThis.crypto === null) {
  globalThis.crypto = {};
}
if (typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto.getRandomValues = (array) => ExpoCrypto.getRandomValues(array);
}

/*
 * Turning bytes back into text (TextDecoder, UTF-8 only). The chat and its
 * encryption library use it; newer Android app engines have it built in,
 * this is only a stand-in in case one doesn't.
 */
if (typeof globalThis.TextDecoder !== 'function') {
  globalThis.TextDecoder = class TextDecoder {
    constructor(label = 'utf-8') {
      if (!/^utf-?8$/i.test(String(label))) throw new RangeError(`Only UTF-8 is supported, not ${label}`);
      this.encoding = 'utf-8';
    }

    // The WHATWG "UTF-8 decoder" steps, so broken bytes give the same "�" as browsers.
    decode(input) {
      if (input === undefined) return '';
      const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
      const BAD = 0xfffd;
      let out = '';
      let cp = 0;
      let seen = 0;
      let needed = 0;
      let lower = 0x80;
      let upper = 0xbf;
      for (let i = 0; i <= b.length; i += 1) {
        if (i === b.length) {
          if (needed) out += String.fromCodePoint(BAD);
          break;
        }
        const byte = b[i];
        if (needed === 0) {
          if (byte <= 0x7f) out += String.fromCharCode(byte);
          else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; cp = byte & 0x1f; }
          else if (byte >= 0xe0 && byte <= 0xef) {
            if (byte === 0xe0) lower = 0xa0;
            if (byte === 0xed) upper = 0x9f;
            needed = 2; cp = byte & 0x0f;
          } else if (byte >= 0xf0 && byte <= 0xf4) {
            if (byte === 0xf0) lower = 0x90;
            if (byte === 0xf4) upper = 0x8f;
            needed = 3; cp = byte & 0x07;
          } else out += String.fromCodePoint(BAD);
          continue;
        }
        if (byte < lower || byte > upper) {
          // Broken sequence: one replacement, and this byte is looked at again.
          cp = 0; needed = 0; seen = 0; lower = 0x80; upper = 0xbf;
          out += String.fromCodePoint(BAD);
          i -= 1;
          continue;
        }
        lower = 0x80; upper = 0xbf;
        cp = (cp << 6) | (byte & 0x3f);
        seen += 1;
        if (seen === needed) {
          out += String.fromCodePoint(cp);
          cp = 0; needed = 0; seen = 0;
        }
      }
      return out;
    }
  };
}
