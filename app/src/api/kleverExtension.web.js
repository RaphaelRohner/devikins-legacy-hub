/**
 * kleverExtension.web.js
 *
 * Talks to the Klever browser extension (the "Klever Wallet" add-on for
 * Chrome and similar browsers). Website only: the build tool picks this
 * ".web.js" file for the browser and kleverExtension.js for the phone.
 *
 * The extension makes itself available to web pages as `window.kleverWeb`
 * (and `window.kleverHub` for connecting). The steps below follow exactly
 * what Klever's own library (@klever/connect-wallet) does in its
 * "extension mode". We don't use that library directly because it refuses
 * to run inside an Expo website (it mistakes it for a phone app).
 *
 * Safety: the Hub never sees a private key. "Connect" only reads the
 * wallet's public address. "Donate" asks the extension to build, sign and
 * send a KLV transfer; the extension shows it and nothing happens unless
 * the person approves it there.
 */

export function isExtensionAvailable() {
  return typeof window !== 'undefined' && !!window.kleverWeb;
}

let connectedAddress = '';

// Which network the extension is currently set to. Addresses are the
// same on mainnet and testnet, but a donation must go out on mainnet.
function extensionNetwork() {
  try {
    const uris = JSON.stringify(window.kleverWeb.getProvider?.() ?? {}).toLowerCase();
    if (uris.includes('testnet')) return 'testnet';
    if (uris.includes('devnet')) return 'devnet';
    if (uris.includes('mainnet')) return 'mainnet';
  } catch (e) {
    // fall through
  }
  return 'unknown';
}

/**
 * Connects to the extension (it may ask the person to approve) and returns
 * { address, network }. Throws an Error with a plain-English message if
 * the extension is missing or no wallet is open in it.
 */
export async function connectExtension() {
  if (!isExtensionAvailable()) {
    throw new Error(
      'The Klever browser extension was not found. Install "Klever Wallet" for your browser, open it once, then reload this page.'
    );
  }
  try {
    if (window.kleverHub?.initialize) {
      await window.kleverHub.initialize();
    }
    connectedAddress = window.kleverWeb.getWalletAddress() || '';
  } catch (e) {
    connectedAddress = '';
  }
  if (!connectedAddress) {
    throw new Error(
      'Could not get a wallet from the Klever extension. Unlock it, make sure a wallet is selected, and try again.'
    );
  }
  return { address: connectedAddress, network: extensionNetwork() };
}

/**
 * Sends `klvAmount` KLV to `receiver` through the extension and returns
 * the transaction hash. The person approves (or rejects) it in the
 * extension. Refuses to send unless the extension is on mainnet.
 */
export async function sendKlvWithExtension(receiver, klvAmount) {
  // KLV has 6 decimal places: 1 KLV = 1,000,000 of its smallest unit.
  const units = Math.round(Number(klvAmount) * 1_000_000);
  if (!Number.isFinite(units) || units <= 0) {
    throw new Error('Please enter an amount above 0.');
  }

  const { network } = await connectExtension();
  if (network !== 'mainnet') {
    throw new Error(
      `Your Klever extension is set to ${network === 'unknown' ? 'an unknown network' : network}. Switch it to Mainnet first, then try again.`
    );
  }

  const kw = window.kleverWeb;
  try {
    // Contract type 0 = a plain transfer (of KLV, since no token is named).
    const unsigned = await kw.buildTransaction([
      // The amount must be a plain number here, not text (the extension
      // rejects text with "cannot unmarshal string ... amount").
      { type: 0, payload: { contractType: 0, toAddress: receiver, receiver, amount: units } },
    ]);
    const signed = await kw.signTransaction(unsigned);
    const response = await kw.broadcastTransactions([signed]);
    if (response?.error) throw new Error(response.error);
    const hash = response?.data?.txsHashes?.[0];
    if (!hash) throw new Error('the network did not return a transaction hash');
    return hash;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/reject|denied|cancel/i.test(msg)) {
      throw new Error('The donation was cancelled in the extension. Nothing was sent.');
    }
    throw new Error(`The extension could not send it: ${msg}`);
  }
}
