/**
 * theme.js
 *
 * Every color the app uses, in two flavors: light and dark. Nothing else
 * in the app should hardcode a color directly - components pull colors
 * from whichever of these two objects is currently active (via
 * useTheme() in ThemeContext.js) so that toggling dark mode instantly
 * re-skins the whole app instead of requiring per-screen changes.
 */

export const lightColors = {
  mode: 'light',
  background: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: '#f7f7fa',
  text: '#111111',
  secondaryText: '#888888',
  border: '#dddddd',
  primary: '#3366cc',
  primaryDisabled: '#99aedd',
  primaryText: '#ffffff',
  chipBackground: '#f1f1f5',
  chipText: '#333333',
  placeholderBackground: '#eeeeee',
  placeholderText: '#999999',
  statusUnavailableBackground: '#eeeeee',
  statusFailedBackground: '#fde2e1',
  statusText: '#555555',
  progressBackground: '#eef4ff',
  progressText: '#223355',
  progressTrack: '#d8e4fb',
  cancelText: '#cc3333',
  cardShadow: '#000000',
};

export const darkColors = {
  mode: 'dark',
  background: '#121214',
  surface: '#1c1c1f',
  surfaceAlt: '#202024',
  text: '#f2f2f2',
  secondaryText: '#9a9aa0',
  border: '#3a3a3f',
  primary: '#7fa2f0',
  primaryDisabled: '#3a4a6b',
  primaryText: '#0c0c0e',
  chipBackground: '#2a2a30',
  chipText: '#e2e2e6',
  placeholderBackground: '#2a2a2e',
  placeholderText: '#7a7a80',
  statusUnavailableBackground: '#2a2a2e',
  statusFailedBackground: '#4a2624',
  statusText: '#cfcfd4',
  progressBackground: '#1c2436',
  progressText: '#c9d6f5',
  progressTrack: '#2c3a57',
  cancelText: '#ff8078',
  cardShadow: '#000000',
};
