import { useEffect, useState } from 'react';
/**
 * chatDock.js - lets any part of the Hub open the chat window
 * (ChatDock.web.js): the ☰ menu's "Chat", the G C shortcut.
 */
let opener = null;
export function setChatDockOpener(fn) {
  opener = fn;
}
/** Opens the chat window; returns false if there is none (the phone app). */
export function openChatDock() {
  if (!opener) return false;
  opener();
  return true;
}

// The Hub's own database has to be ready before the chat opens its own
// (both at once could stall the Hub's start-up). App.js says when.
let hubReady = false;
const readyListeners = new Set();
export function setHubReady() {
  hubReady = true;
  for (const fn of readyListeners) fn();
  readyListeners.clear();
}
export function whenHubReady(fn) {
  if (hubReady) fn();
  else readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

// How many chat messages and group posts are unread (ChatDock.web.js says),
// for the ☰ button and the menu's "Chat" entry - on a narrow screen there's
// no floating chat tab, so that's where the count shows (Raphael, 24 Oct 2026).
let unreadCount = 0;
const unreadListeners = new Set();
export function setChatUnread(n) {
  if (n === unreadCount) return;
  unreadCount = n;
  for (const fn of unreadListeners) fn(n);
}
export function useChatUnread() {
  const [n, setN] = useState(unreadCount);
  useEffect(() => {
    unreadListeners.add(setN);
    setN(unreadCount);
    return () => unreadListeners.delete(setN);
  }, []);
  return n;
}

// --- Android app: the draggable 💬 handle (ChatDock.js, 26 Oct 2026) ---
// App.js says which screen is showing, so the handle can step aside on the
// chat itself and before the Hub has started, and how to open the chat.
let appScreen = null;
const screenListeners = new Set();
export function setAppScreen(screen) {
  if (screen === appScreen) return;
  appScreen = screen;
  for (const fn of screenListeners) fn(screen);
}
export function useAppScreen() {
  const [s, setS] = useState(appScreen);
  useEffect(() => {
    screenListeners.add(setS);
    setS(appScreen);
    return () => screenListeners.delete(setS);
  }, []);
  return s;
}
let chatScreenOpener = null;
export function setChatScreenOpener(fn) {
  chatScreenOpener = fn;
}
export function openChatScreen() {
  if (chatScreenOpener) chatScreenOpener();
}
