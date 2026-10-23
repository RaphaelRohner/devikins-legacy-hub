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
