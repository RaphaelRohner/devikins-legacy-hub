/**
 * chatStore.js — the Hub's link to the chat core (app/chat)
 *
 * Opens the chat's own small database ("chat.db", separate from the wallet
 * sets, so switching or deleting sets never touches the chat) and starts
 * the messenger once. Everything chat-related on screens goes through
 * getMessenger().
 */

import * as SQLite from 'expo-sqlite';
import { createMessenger } from '../../chat/src/messenger.js';
import { POSTMAN_URL } from '../constants/chat';

export const CHAT_DATABASE_FILE_NAME = 'chat.db';

let messengerPromise = null;

export function getMessenger() {
  if (!messengerPromise) {
    messengerPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(CHAT_DATABASE_FILE_NAME);
      return createMessenger({ db, postmanUrl: POSTMAN_URL });
    })().catch((e) => {
      messengerPromise = null;
      throw e;
    });
  }
  return messengerPromise;
}
