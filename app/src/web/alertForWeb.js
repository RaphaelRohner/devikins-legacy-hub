/**
 * alertForWeb.js
 *
 * On the phone, Alert.alert shows a native pop-up with buttons. In the
 * browser version of React Native, Alert.alert does nothing at all - so
 * messages would silently vanish and "Are you sure?" questions would never
 * get an answer.
 *
 * This file fills that gap on the website only, with the Hub's own small
 * message box drawn inside the page (title, text, and the same buttons the
 * phone would show).
 *
 * Why not the browser's own window.alert / window.confirm (used until
 * 11 Oct 2026): while one of those is open, the browser pauses the whole
 * page - a running Fetch/Update stopped until the box was closed (Raphael
 * noticed it at "74 of ..."). This box doesn't pause anything.
 *
 * The automatic tests (tests/web) set window.__HUB_NATIVE_DIALOGS to get
 * the browser's own boxes, which they read and close by themselves.
 *
 * Loaded once at start-up from index.js; does nothing on the phone.
 */

import { Alert, Platform } from 'react-native';

function isDarkPage() {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (!m) return true;
    const [r, g, b] = m.map(Number);
    return r * 0.299 + g * 0.587 + b * 0.114 < 128;
  } catch (e) {
    return true;
  }
}

function showInPageDialog(title, message, buttons) {
  const dark = isDarkPage();
  const colors = dark
    ? { card: '#1c1c1f', text: '#f2f2f2', sub: '#c9c9cf', border: '#3a3a3f', primary: '#7fa2f0', primaryText: '#0c0c0e', danger: '#ff8078' }
    : { card: '#ffffff', text: '#111111', sub: '#444444', border: '#dddddd', primary: '#3366cc', primaryText: '#ffffff', danger: '#cc3333' };

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.dataset.hubDialog = '1';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)', zIndex: '100000',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: colors.card, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '12px',
    maxWidth: '440px', width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: '18px', boxSizing: 'border-box',
    boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
  });

  if (title) {
    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, { fontSize: '17px', fontWeight: '700', marginBottom: message ? '8px' : '14px' });
    card.appendChild(h);
  }
  if (message) {
    const p = document.createElement('div');
    p.textContent = message;
    Object.assign(p.style, { fontSize: '14px', lineHeight: '20px', color: colors.sub, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '16px' });
    card.appendChild(p);
  }

  const list = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' });

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  const cancel = list.find((b) => b.style === 'cancel');
  function onKey(e) {
    if (e.key === 'Escape') {
      close();
      cancel?.onPress?.();
    }
  }

  list.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.text || 'OK';
    const isMain = b.style !== 'cancel' && i === list.length - 1;
    Object.assign(btn.style, {
      fontSize: '15px', fontWeight: '700', padding: '9px 16px', borderRadius: '8px', cursor: 'pointer',
      border: `1px solid ${isMain ? colors.primary : colors.border}`,
      background: isMain ? colors.primary : 'transparent',
      color: isMain ? colors.primaryText : b.style === 'destructive' ? colors.danger : colors.text,
    });
    btn.addEventListener('click', () => {
      close();
      b.onPress?.();
    });
    row.appendChild(btn);
  });
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  row.lastChild?.focus();
}

function showNativeDialog(title, message, buttons) {
  const text = [title, message].filter(Boolean).join('\n\n');
  if (!buttons || buttons.length <= 1) {
    window.alert(text);
    buttons?.[0]?.onPress?.();
    return;
  }
  const cancel = buttons.find((b) => b.style === 'cancel');
  const action = buttons.find((b) => b !== cancel);
  if (window.confirm(text)) {
    action?.onPress?.();
  } else {
    cancel?.onPress?.();
  }
}

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  Alert.alert = (title, message, buttons) => {
    if (window.__HUB_NATIVE_DIALOGS) showNativeDialog(title, message, buttons);
    else showInPageDialog(title, message, buttons);
  };
}
