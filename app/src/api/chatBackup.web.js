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
import { publicAlbums } from '../../chat/src/client.js';
import { POSTMAN_URL } from '../constants/chat';
import { getStoredNfts } from '../db/database';
import { gameNameOf } from '../constants/schema';

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
    const rows = await (await getMessenger()).myAlbums();
    const published = rows.filter((r) => r.album);
    if (published.length === 0) return null;
    return albumsPlainCopy(rows, {
      nfts: await nftDetails(published),
      comments: await albumComments(published),
    });
  } catch {
    return null;
  }
}

const SINGULAR = { devikin: 'Devikin', weapon: 'Weapon', equipment: 'Equipment' };

/**
 * Per NFT ("kind/number"): the title the album shows (the game name, else
 * "Rare Glysian Devikin" from its traits – same rule as AlbumsView), the name
 * you gave it in the Hub and your Hub comment. From this Hub's own database;
 * NFTs it hasn't loaded get no title (no slow lookups during a backup).
 */
async function nftDetails(published) {
  const out = {};
  for (const kind of Object.keys(SINGULAR)) {
    const nonces = [...new Set(published.flatMap((r) => r.album.items.filter((i) => i.kind === kind).map((i) => i.nonce)))];
    if (!nonces.length) continue;
    const stored = await getStoredNfts(kind, nonces).catch(() => []);
    for (const row of stored) {
      const title = gameNameOf(row)
        || [row.rarity, kind === 'devikin' ? row.ancestry : row.type, SINGULAR[kind]].filter(Boolean).join(' ');
      out[`${kind}/${row.nonce}`] = { title, yourName: row.custom_name || '', hubComment: row.comment || '' };
    }
  }
  return out;
}

/** The comments under each album's NFTs, from the postman (public, no sign-in); null if it can't be reached. */
async function albumComments(published) {
  const reader = publicAlbums({ baseUrl: POSTMAN_URL });
  const out = {};
  for (const r of published) out[r.key] = await reader.comments(r.key).catch(() => null);
  return out;
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
