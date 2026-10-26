/**
 * chatWallet.js - how the chat signs in and votes IN THE ANDROID APP
 * (26 Oct 2026): with the KLV Signer app (version 0.1.3 or newer), which
 * signs a short text after you approve it there (no transaction, no fee;
 * request type SIGN_MESSAGE, see klvSigner.js). The answer is checked
 * before it's used. The website's version is chatWallet.web.js (Klever
 * browser extension); the chat screens are the same for both.
 */
import { signTextWithSigner, lastSignerDetails } from './klvSigner';

/** Always "yes": whether the Signer is installed is found out when asking it (clear message then). */
export const canSignChat = () => true;

/** Signs `text` -> { address, signature }. Throws with a plain-English message. */
export const signChatText = (text) => signTextWithSigner(text);

/** What the Signer gave back last time (public things only), to send when it didn't fit. */
export const lastChatSigningDetails = () => lastSignerDetails();

/** Words for the screens. */
export const CHAT_WALLET = 'KLV Signer app';
export const CHAT_HERE = 'this app';
export const CHAT_DEVICE = 'phone';
export const CHAT_NO_WALLET_TEXT = 'To sign in, you need the KLV Signer app (version 0.1.3 or newer) with the wallet that holds your Devikins.';
