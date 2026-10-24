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
