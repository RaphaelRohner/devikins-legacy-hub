/**
 * layout.js
 *
 * Small screen-width-based helpers for the handful of places that need
 * to look right on a tablet's much wider screen, not just a phone's -
 * see CollectionView.js and NftTile.js for where these are used.
 *
 * Deliberately keyed off the actual measured window width (via React
 * Native's `useWindowDimensions` in the callers), not `Platform.isPad`
 * or the device's OS - an Android tablet is just as wide as an iPad, so
 * "is this a tablet" isn't really the right question; "how much width
 * is actually available right now" is, and it also means these update
 * live on rotation or iPad split-screen resizing (useWindowDimensions
 * re-renders on that, unlike the older, one-time Dimensions.get()).
 */

// How many tiles fit comfortably per row in Tiles view, by window
// width. 3 was this app's original, phone-only value; the wider
// brackets above it are new, each one keeping individual tile size in
// roughly the same comfortable range rather than tiles just getting
// bigger and bigger for no reason as the screen gets wider.
export function getTileColumns(width) {
  if (width >= 1100) return 6;
  if (width >= 850) return 5;
  if (width >= 600) return 4;
  return 3;
}

// The exact ratio the original 3-column tile design used - 100/3 minus
// the hand-picked 31% it settled on - reused here for any column count
// so the gap between tiles (via `justifyContent: 'space-between'` on
// each row - see CollectionView.js's tilesRow) stays visually
// consistent whether a row has 3 tiles or 6.
export function getTileFlexBasisPercent(columns) {
  return `${100 / columns - 2.33}%`;
}

// A single-column list row or the full NFT detail view reads fine at
// phone width, but stretched edge-to-edge across a tablet's full width
// it would leave labels/values spread unnaturally far apart instead of
// reading as one compact card/row. Every phone screen is comfortably
// under this, so it's a no-op there - it only ever affects a tablet.
export const SINGLE_COLUMN_MAX_WIDTH = 700;

// Turns SINGLE_COLUMN_MAX_WIDTH into actual horizontal padding for a
// given window width, so content past that width ends up centered
// instead of genuinely widening - rather than editing every row/card
// component individually, this is meant to be applied once, to the
// padding of whatever scrollable container holds them (see
// CollectionView.js). Below the cap, just returns the normal base
// padding those containers already used everywhere else in the app.
export function getCenteredContentPadding(width, basePadding = 12) {
  if (width <= SINGLE_COLUMN_MAX_WIDTH) return basePadding;
  return Math.round((width - SINGLE_COLUMN_MAX_WIDTH) / 2);
}
