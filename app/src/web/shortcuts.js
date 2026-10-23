/**
 * shortcuts.js - keyboard shortcuts on the website (Raphael, 22-23 Oct
 * 2026: "jump to sections without using the menu").
 *
 * Gmail / GitHub style: press G ("go"), then a letter, e.g. G then W for
 * Withdrawals. ? shows the list. (Ctrl/Cmd+W, T, N, Q can't be used: the
 * browser keeps those for itself.)
 *
 *   - Ignored while typing in a text box, and when Ctrl, Cmd or Alt is held,
 *     so writing a chat message or using the browser's own shortcuts never
 *     jumps anywhere.
 *   - The second key has to follow within GO_WINDOW_MS.
 *   - Does nothing on the phone (no keyboard listener there).
 *
 * The list is used by App.js (what each key does), the ☰ menu (shows the
 * keys next to its entries) and ShortcutsHelp.js (the "?" box).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export const IS_WEB = Platform.OS === 'web';

// key -> what it opens (the screen names App.js uses; 'fetch' = Fetch/Update)
export const SHORTCUTS = [
  { key: 'd', action: 'devikin', label: 'Devikins' },
  { key: 'a', action: 'weapon', label: 'Weapons (A for arms)' },
  { key: 'e', action: 'equipment', label: 'Equipment' },
  { key: 'o', action: 'overview', label: 'Where are my NFTs? (overview)' },
  { key: 'c', action: 'chat', label: 'Chat' },
  { key: 'w', action: 'withdrawals', label: 'Withdrawals' },
  { key: 'b', action: 'breeding', label: 'Breeding Helper' },
  { key: 's', action: 'wallets', label: 'Wallets (Set Up)' },
  { key: 'f', action: 'fetch', label: 'Fetch/Update' },
];

const GO_WINDOW_MS = 1500;

/** "G W" for an action, or '' (shown next to the menu entries). */
export function shortcutFor(action) {
  const s = SHORTCUTS.find((x) => x.action === action);
  return s ? `G ${s.key.toUpperCase()}` : '';
}

function isTyping(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

/** Decides what one key press means, given whether G was pressed just before. */
export function readKey(event, goPressedAt, now = Date.now()) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return { go: 0 };
  if (isTyping(event.target)) return { go: 0 };
  const key = String(event.key || '');
  if (key === '?') return { action: 'help', go: 0 };
  const lower = key.toLowerCase();
  if (goPressedAt && now - goPressedAt <= GO_WINDOW_MS) {
    const s = SHORTCUTS.find((x) => x.key === lower);
    if (s) return { action: s.action, go: 0 };
  }
  if (lower === 'g' && !event.shiftKey) return { go: now };
  return { go: 0 };
}

/** Calls onAction(action) for each shortcut used (website only). */
export function useKeyboardShortcuts(onAction) {
  const handlerRef = useRef(onAction);
  handlerRef.current = onAction;
  useEffect(() => {
    if (!IS_WEB || typeof window === 'undefined') return undefined;
    let goPressedAt = 0;
    function onKeyDown(event) {
      const r = readKey(event, goPressedAt);
      goPressedAt = r.go;
      if (r.action) {
        event.preventDefault();
        handlerRef.current?.(r.action);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// The "?" box lives next to the whole app (App.js), so any screen can open it.
let openHelp = null;
export function setShortcutsHelpOpener(fn) {
  openHelp = fn;
}
export function showShortcutsHelp() {
  openHelp?.();
}
