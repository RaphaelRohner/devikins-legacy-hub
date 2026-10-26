/**
 * chatWallet.web.js - how the chat signs in and votes ON THE WEBSITE
 * (26 Oct 2026): with the Klever browser extension, which signs a short
 * text (no transaction, no fee). The Android app's version is
 * chatWallet.js (the KLV Signer app). The chat screens only use this file,
 * so they are the same on the website and in the app.
 */
import { isExtensionAvailable, signTextWithExtension, lastSigningDetails } from './kleverExtension';

/** Can this device sign at all right now? (Extension installed?) */
export const canSignChat = () => isExtensionAvailable();

/** Signs `text` -> { address, signature }. Throws with a plain-English message. */
export const signChatText = (text) => signTextWithExtension(text);

/** What the wallet gave back last time (public things only), to send when it didn't fit. */
export const lastChatSigningDetails = () => lastSigningDetails();

/** Words for the screens. */
export const CHAT_WALLET = 'Klever extension'; // "your Klever extension asks you to sign…"
export const CHAT_HERE = 'this browser'; // where the chat's history is kept
export const CHAT_DEVICE = 'computer'; // "sealed on your computer"
export const CHAT_NO_WALLET_TEXT = 'To sign in, you need the Klever Wallet browser extension (for Chrome, Brave or Edge) with the wallet that holds your Devikins. Install it, open it once, then reload this page.';
