/*
 * modules/klv-signer-check/index.js — JavaScript access to the seal check
 * =======================================================================
 *
 * signerStatus(packageName, certSha256Hex) → 'official' | 'different' |
 *   'not_installed' | 'unknown', from the native part
 *   (android/.../KlvSignerCheckModule.kt).
 *
 * If the native part is missing (e.g. Expo Go, or tests on a computer) the
 * answer is 'unavailable', and src/api/klvSigner.js then refuses to talk to
 * the Signer: when in doubt, don't send.
 */

import { requireOptionalNativeModule } from 'expo';

const native = requireOptionalNativeModule('KlvSignerCheck');

export function signerStatus(packageName, certSha256Hex) {
  if (!native) return 'unavailable';
  try {
    return native.signerStatus(packageName, certSha256Hex);
  } catch {
    return 'unknown';
  }
}
