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
import { albumsPlainCopy } from '../../chat/src/album.js';

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

/**
 * The open copy of my albums for the backup (21 Nov 2026, suggested by
 * jenniferseward): { json, csv } or null when there's no published album.
 * NOT locked – it holds only the album texts and NFT numbers, no keys or
 * messages (album.js albumsPlainCopy). Never stops the backup: on any
 * problem the backup simply goes without it.
 */
export async function makePlainAlbumsCopy() {
  try {
    return albumsPlainCopy(await (await getMessenger()).myAlbums());
  } catch {
    return null;
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
