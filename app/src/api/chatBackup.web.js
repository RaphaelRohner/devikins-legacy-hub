/**
 * chatBackup.web.js — the chat's part of "Export all sets" (website)
 *
 * The chat (chat key, contacts, messages) goes into the full backup as
 * one file, chat-backup.json, locked with a password the person chooses
 * (app/chat/src/backup.js). Importing a backup that has it asks for that
 * password and brings the chat back - into a browser that has no chat
 * of its own yet.
 */

import { getMessenger } from './chatStore';
import { lockBackup, unlockBackup, MIN_PASSWORD_LENGTH } from '../../chat/src/backup.js';

export const CHAT_BACKUP_FILE_NAME = 'chat-backup.json';
export { MIN_PASSWORD_LENGTH };

/** Is there a chat in this browser that a backup should offer to include? */
export async function hasChatToBackUp() {
  try {
    return await (await getMessenger()).hasChat();
  } catch {
    return false;
  }
}

/** The locked chat backup file's text. */
export async function makeChatBackupText(password) {
  const messenger = await getMessenger();
  return JSON.stringify(await lockBackup(await messenger.backupData(), password));
}

/**
 * Opens a locked chat backup and brings the chat back here.
 * → { nickname } ; throws (e.wrongPassword for a wrong password).
 */
export async function restoreChatBackupText(text, password) {
  let locked;
  try {
    locked = JSON.parse(text);
  } catch {
    throw new Error("The chat in this backup can't be read.");
  }
  const data = await unlockBackup(locked, password);
  const status = await (await getMessenger()).restoreBackupData(data);
  return { nickname: status.nickname };
}
