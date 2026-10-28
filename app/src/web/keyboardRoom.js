/**
 * keyboardRoom.js - the website on a phone: how much of the screen the
 * on-screen keyboard covers right now, in pixels (0 when it's closed or on a
 * computer). Raphael, 28 Oct 2026: in the Klever app's K5 browser the keyboard
 * covered the field being typed in (wallet address, chat message, album
 * comment), because that browser lays the keyboard over the page without
 * making the page smaller.
 *
 * How it knows:
 *   1. Most phone browsers report the visible part of the page ("visual
 *      viewport"): what's below it is keyboard.
 *   2. Some in-app browsers report nothing. Then, while a text field has the
 *      focus on a touch screen and the page didn't get smaller by itself,
 *      the keyboard is counted as about the lower 42 % of the screen.
 *
 * App.js (the whole Hub), ChatDock.web.js (the chat window) and the album's
 * NFT pop-up make that much room at the bottom; App.js also scrolls the field
 * into view (`scrollField`). The Android app does this with its own keyboard
 * events (App.js, KeyboardAvoidingView); nothing happens there.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image', 'hidden']);

/** The text field that has the focus, if any. */
function focusedField() {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  if (!el) return null;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || el.isContentEditable) return el;
  if (tag === 'input' && !NOT_TEXT.has(String(el.type || 'text').toLowerCase())) return el;
  return null;
}

export const ESTIMATED_SHARE = 0.42;

export function useWebKeyboardRoom({ scrollField = false } = {}) {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    // (the page's height with the keyboard closed: a page that got smaller by itself needs no help)
    const fullHeight = window.innerHeight;
    let timer = null;
    let lastRoom = 0;
    function measure() {
      const vv = window.visualViewport;
      let r = 0;
      if (vv) {
        const covered = window.innerHeight - vv.height - vv.offsetTop;
        if (covered > 80) r = Math.round(covered);
      }
      const field = focusedField();
      if (!r && field) {
        const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && window.innerWidth < 900;
        const shrunk = window.innerHeight < fullHeight - 100;
        if (touch && !shrunk) r = Math.round(window.innerHeight * ESTIMATED_SHARE);
      }
      if (r !== lastRoom) {
        lastRoom = r;
        setRoom(r);
      }
      clearTimeout(timer);
      // (a moment later, once the page has made room: the field into the middle of what's visible)
      if (scrollField && r && field) timer = setTimeout(() => focusedField()?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 150);
    }
    // (focusout comes before the next field has the focus)
    const later = () => setTimeout(measure, 60);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', later);
    measure();
    return () => {
      clearTimeout(timer);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', later);
    };
  }, [scrollField]);
  return room;
}
