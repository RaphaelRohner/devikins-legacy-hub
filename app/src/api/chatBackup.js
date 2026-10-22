/**
 * chatBackup.js — phone version: the chat is on the website only for now,
 * so phone backups have no chat part (a website backup's chat part is
 * simply left out when it's imported on the phone).
 */
export const CHAT_BACKUP_FILE_NAME = 'chat-backup.json';
export const MIN_PASSWORD_LENGTH = 8;
export async function hasChatToBackUp() { return false; }
export async function makeChatBackupText() { throw new Error('The chat is only on the website for now.'); }
export async function restoreChatBackupText() { throw new Error('The chat is only on the website for now.'); }
