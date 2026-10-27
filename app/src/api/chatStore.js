/**
 * chatStore.js — the Hub's link to the chat core (app/chat)
 *
 * Opens the chat's own small database ("chat.db", separate from the wallet
 * sets, so switching or deleting sets never touches the chat) and starts
 * the messenger once. Everything chat-related on screens goes through
 * getMessenger().
 */

import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { createMessenger } from '../../chat/src/messenger.js';
import { POSTMAN_URL, DEVICES_CHECK_EVERY_MS } from '../constants/chat';

export const CHAT_DATABASE_FILE_NAME = 'chat.db';

/**
 * Which device this is, as shown on the player's other linked devices
 * (Raphael, 27 Oct 2026): the browser and system on the website ("Chrome on
 * Mac"), the phone's maker and model in the app ("Motorola moto g(5)
 * (Android app)"). Only ever sent sealed to the player's own devices.
 */
export function chatDeviceLabel() {
  if (Platform.OS !== 'web') {
    const c = Platform.constants || {};
    const maker = String(c.Manufacturer || c.Brand || '').trim();
    const model = String(c.Model || '').trim();
    const Maker = maker ? maker[0].toUpperCase() + maker.slice(1) : '';
    const name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${Maker} ${model}`.trim();
    return name ? `${name} (Android app)` : 'Android app';
  }
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  const inKleverApp = /; wv\)/.test(ua) && typeof window !== 'undefined' && !!window.kleverWeb;
  let browser = 'Browser';
  if (inKleverApp) browser = 'Klever app';
  else if (typeof navigator !== 'undefined' && navigator.brave) browser = 'Brave';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let system = '';
  if (/Android/.test(ua)) system = 'Android';
  else if (/iPhone|iPad/.test(ua)) system = 'iPhone/iPad';
  else if (/Mac OS X/.test(ua)) system = 'Mac';
  else if (/Windows/.test(ua)) system = 'Windows';
  else if (/Linux|CrOS/.test(ua)) system = 'Linux';
  return system ? `${browser} on ${system}` : browser;
}

let messengerPromise = null;

export function getMessenger() {
  if (!messengerPromise) {
    messengerPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(CHAT_DATABASE_FILE_NAME);
      // (the kind of device, shown on the player's other linked devices)
      return createMessenger({ db, postmanUrl: POSTMAN_URL, deviceLabel: chatDeviceLabel(), devicesCheckEveryMs: DEVICES_CHECK_EVERY_MS });
    })().catch((e) => {
      messengerPromise = null;
      throw e;
    });
  }
  return messengerPromise;
}
