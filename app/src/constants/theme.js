/**
 * theme.js
 *
 * Every color the app uses, in two flavors: light and dark. Nothing else
 * in the app should hardcode a color directly - components pull colors
 * from whichever of these two objects is currently active (via
 * useTheme() in ThemeContext.js) so that toggling dark mode instantly
 * re-skins the whole app instead of requiring per-screen changes.
 *
 * toolbarBackground/toolbarDivider (added later, for the three control
 * rows above every collection's list - App.js's menuRow/searchRow and
 * CollectionView.js's filterBar) are a deliberately separate pair from
 * surface/surfaceAlt above, not a rename of them. An earlier version of
 * those three rows used surfaceAlt as their shared background with
 * surface for the buttons sitting on it - per feedback that looked
 * wrong (surface and surfaceAlt sit close together in both themes, so
 * the buttons barely stood out). toolbarBackground is chosen to read as
 * clearly darker than surface (which the buttons still use) in both
 * themes, and toolbarDivider is chosen to read as clearly LIGHTER than
 * toolbarBackground - it's the thin line under the whole three-row
 * block, marking where the toolbar ends and the list begins.
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
  toolbarBackground: '#e2e2e8',
  toolbarDivider: '#f4f4f8',
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
  toolbarBackground: '#0a0a0c',
  toolbarDivider: '#3a3a3f',
};
