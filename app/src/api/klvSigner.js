/**
 * klvSigner.js
 *
 * Talks to the KLV Signer app: a separate Android app that holds a Klever
 * wallet's private key and signs transactions for other apps, after the
 * user approves each one with their password there. This app (the Hub)
 * never sees the key - it only sends an unsigned transaction and gets back
 * either a signature or a "no".
 *
 * How it works: Android's "start an activity for result" (via
 * expo-intent-launcher). Android tells the Signer which app is asking and
 * hands the answer back only to us. The exact rules are the Signer's own
 * SIGNER-PROTOCOL.md (in the KLV Signer project); this file follows it.
 *
 * Two things we can ask:
 *   getSignerAddress()          -> which wallet is in the Signer (klv1...)
 *   signWithSigner(unsignedHex) -> { signedTransaction, transactionHash, ... }
 *
 * Both throw an Error with a plain-English `message` and a `code` when the
 * answer is "no" (e.g. code 'USER_REJECTED' when the user tapped Reject,
 * 'NOT_INSTALLED' if the Signer app isn't on the phone).
 *
 * Android 11+ only lets us talk to the Signer because app.json lists it
 * under <queries> - see plugins/withKlvSigner.js.
 */

import * as IntentLauncher from 'expo-intent-launcher';

// Always name the Signer exactly (package + screen), so no other app can
// catch our request - see SIGNER-PROTOCOL.md section 2b.
const SIGNER = {
  packageName: 'com.raphaelrohner.klvsigner',
  className: 'com.raphaelrohner.klvsigner.requests.SignRequestActivity',
};

const ACTION = {
  GET_ADDRESS: 'com.raphaelrohner.klvsigner.action.GET_ADDRESS',
  SIGN_TRANSACTION: 'com.raphaelrohner.klvsigner.action.SIGN_TRANSACTION',
};

const PROTOCOL_VERSION = '1';

// Opens the Signer for one request and waits for its answer. Returns the
// answer's values when it said "ok", throws otherwise.
async function askSigner(action, extra = {}) {
  let result;
  try {
    result = await IntentLauncher.startActivityAsync(action, {
      ...SIGNER,
      extra: { protocolVersion: PROTOCOL_VERSION, ...extra },
    });
  } catch (error) {
    // Android couldn't find the Signer's screen: most likely not installed.
    throw Object.assign(
      new Error('The KLV Signer app is not installed on this phone (or is too old).'),
      { code: 'NOT_INSTALLED', cause: error },
    );
  }

  const answer = result.extra || {};
  if (result.resultCode === IntentLauncher.ResultCode.Success && answer.status === 'ok') {
    return answer;
  }
  // "Cancelled" with no details at all (e.g. the Signer was closed by the
  // system) is treated like a normal "no", per the protocol.
  throw Object.assign(new Error(answer.message || 'Cancelled in the KLV Signer.'), {
    code: answer.error || 'USER_REJECTED',
  });
}

/** Asks the Signer which wallet it holds. Returns the klv1... address. */
export async function getSignerAddress() {
  const answer = await askSigner(ACTION.GET_ADDRESS);
  return answer.address;
}

/**
 * Asks the Signer to sign an unsigned transaction (hex). The Signer shows
 * the user what it does, asks for their password, and signs - or says no.
 * Returns { signedTransaction, transactionHash, signature, address, network }.
 */
export async function signWithSigner(unsignedHex) {
  return askSigner(ACTION.SIGN_TRANSACTION, { transaction: unsignedHex });
}
