/**
 * kleverTx.js
 *
 * Preparing and sending Klever transactions - the two jobs that are the
 * Hub's side of signing (the KLV Signer app does the signing itself, see
 * klvSigner.js). TESTNET ONLY for now: the KLV Signer refuses real-network
 * transactions until it has been reviewed further, so everything here is
 * pinned to Klever's practice network, where coins have no real value.
 *
 *   buildTransfer(...)       asks a Klever testnet node to prepare an
 *                            unsigned transfer (it fills in the transaction
 *                            number and fees) - returns it as hex
 *   broadcastSigned(hex)     sends a signed transaction to the testnet,
 *                            returns its hash
 *   getKlvBalance(address)   the address's testnet KLV balance
 *   explorerUrl(hash)        link to see the transaction on testnet Kleverscan
 *
 * Uses Klever's own JavaScript SDK (@klever/connect-provider and
 * @klever/connect-transactions, pinned to exact versions). One quirk
 * found while building the Signer: in connect-provider 0.2.2, sending a
 * signed transaction as a hex string doesn't work (the node answers "nil
 * transaction"), so broadcastSigned() hands it over in JSON form instead.
 */

import { KleverProvider } from '@klever/connect-provider';
import { TransactionBuilder, Transaction } from '@klever/connect-transactions';

export const SIGNER_NETWORK = 'testnet';
const TESTNET_API = 'https://api.testnet.klever.org/v1.0';

let provider = null;
function getProvider() {
  if (!provider) provider = new KleverProvider(SIGNER_NETWORK);
  return provider;
}

/**
 * klvToUnits - "1.5" KLV -> "1500000" (KLV has 6 decimal places). Exact
 * string maths, no rounding. Throws on anything that isn't a plain amount.
 */
export function klvToUnits(text) {
  const clean = String(text || '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(clean)) {
    throw new Error('Please enter an amount like 0.5 or 12.345678 (at most 6 decimals).');
  }
  const [whole, fraction = ''] = clean.split('.');
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw new Error('The amount must be more than 0.');
  return units.toString();
}

/** unitsToKlv - 1500000 -> "1.5". */
export function unitsToKlv(units) {
  const value = BigInt(units);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * buildTransfer - prepares an unsigned testnet transfer.
 *   sender:      the Signer's wallet address (from getSignerAddress)
 *   receiver:    klv1... address
 *   amountUnits: amount in the token's smallest units, as a string
 *   kda:         optional token id (e.g. "ABC-1234") or NFT ("COLLECTION/NUMBER");
 *                leave empty for KLV
 * Returns the unsigned transaction as hex, ready for signWithSigner().
 */
export async function buildTransfer({ sender, receiver, amountUnits, kda }) {
  const transfer = { receiver, amount: amountUnits };
  if (kda) transfer.kda = kda;
  const tx = await new TransactionBuilder(getProvider()).sender(sender).transfer(transfer).build();
  return tx.toHex();
}

/** broadcastSigned - sends a signed transaction (hex) to the testnet. Returns its hash. */
export async function broadcastSigned(signedHex) {
  const json = JSON.stringify(Transaction.fromHex(signedHex).toJSON());
  return getProvider().sendRawTransaction(json);
}

/** getKlvBalance - the address's KLV balance on testnet, in smallest units (0 if the account doesn't exist yet). */
export async function getKlvBalance(address) {
  const response = await fetch(`${TESTNET_API}/address/${address}`);
  const body = await response.json();
  return BigInt(body?.data?.account?.balance ?? 0);
}

/** explorerUrl - where to see a testnet transaction. */
export function explorerUrl(hash) {
  return `https://testnet.kleverscan.org/transaction/${hash}`;
}
