/**
 * ProgressBar.js
 *
 * Shows that fetchAllForWallet.js is running, inline in App.js's top
 * menuRow between the hamburger button and the theme toggle (see
 * App.js's own comment where it's rendered).
 *
 * Used to be a full-width block below that row instead, showing a
 * status line (which collection, how many done), a progress track, and
 * a text "Stop" button - all stacked vertically, which worked fine as
 * its own block but was visibly taller than the row it got moved into.
 * Per feedback, this version is fixed to the SAME 44px height as the
 * hamburger button next to it (see `container` below), so the top row
 * stays one consistent height whether or not a fetch is running - the
 * goal being just a clear, glanceable "something is happening" signal,
 * not the full detail.
 *
 * The full detail (which collection, how many done, or the exact
 * error) is still built exactly as before - it just isn't shown
 * directly anymore. Tapping the bar (anywhere except the ✕) shows it in
 * a plain Alert instead, so nothing that used to be visible here is
 * actually gone, it's just one tap further away.
 *
 * `progress` is whatever fetchAllForWallet.js's onProgress callback
 * most recently received - see that file for the exact shape.
 */

import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useTheme } from '../context/ThemeContext';

export default function ProgressBar({ progress, onCancel, isCancelling }) {
  const { colors } = useTheme();

  if (!progress || progress.phase === 'done') {
    return null;
  }

  let message = '';
  let fractionComplete = null;

  if (progress.phase === 'listing') {
    message = `Looking up ${progress.label} held by this wallet...`;
  } else if (progress.phase === 'summary') {
    // A plain, pre-worded status line - meant for a caller to say up
    // front what kind of work is about to happen (e.g. an NFT refetch
    // vs an image refetch) before the per-collection 'fetching' messages
    // below start coming in. Nothing currently produces this phase (the
    // background auto-retry timer that used to be its only source was
    // removed from App.js, per feedback that fetching should only ever
    // happen when Fetch/Update is tapped) - left in place since it's a
    // harmless, generic capability of this component, not tied to that
    // removed feature specifically.
    message = progress.label;
  } else if (progress.phase === 'fetching') {
    message = `${progress.label}: ${progress.completed} / ${progress.total} fetched`;
    if (progress.skipped) {
      message += ` (${progress.skipped} skipped - already known unavailable)`;
    }
    fractionComplete = progress.total > 0 ? progress.completed / progress.total : 0;
  } else if (progress.phase === 'error') {
    message = `Couldn't list ${progress.label}: ${progress.error}`;
  }

  // When fetching more than one wallet (see fetchAllForWallets/
  // retryPendingItemsForWallets in fetchAllForWallet.js), every progress
  // update is tagged with which wallet it's for - prefix the message with
  // that so it's clear which wallet is currently being worked on, rather
  // than just looking like one wallet is taking a very long time.
  if (progress.walletTotal > 1 && message) {
    message = `Wallet ${progress.walletIndex} of ${progress.walletTotal}: ${message}`;
  }

  function showDetail() {
    if (message) {
      Alert.alert('Fetch status', message);
    }
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
      ]}
    >
      {/* Everything except the ✕ is one big tap target for showDetail() -
          the compact view on purpose doesn't have room for the full
          status text, so tapping it is how that text is still reachable. */}
      <TouchableOpacity style={styles.tapArea} onPress={showDetail} activeOpacity={0.7}>
        {fractionComplete !== null ? (
          // Fetching a specific collection: we know how far through it
          // we are, so show that - a slim fill track plus the percent
          // as a number, both small enough to fit this row's height.
          <>
            <View style={[styles.track, { backgroundColor: colors.progressTrack }]}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.round(fractionComplete * 100)}%`, backgroundColor: colors.primary },
                ]}
              />
            </View>
            <Text style={[styles.percentText, { color: colors.text }]}>
              {Math.round(fractionComplete * 100)}%
            </Text>
          </>
        ) : (
          // Listing/summary/error phases have no fraction to show (we
          // don't yet know a total, or there isn't one) - a plain
          // spinner still reads as "something is happening" without
          // needing a percentage.
          <ActivityIndicator size="small" color={colors.primary} />
        )}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onCancel}
        disabled={isCancelling}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.cancelButton}
      >
        <Text
          style={[
            styles.cancelText,
            { color: colors.cancelText },
            isCancelling && styles.cancelTextDisabled,
          ]}
        >
          {isCancelling ? '…' : '✕'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Matches the hamburger button's own height exactly (see App.js's
    // hamburgerButton style) so the whole top row stays one consistent
    // height, fetch running or not - the reason this file's whole
    // layout changed from a stacked, full-detail block to a single
    // slim row. Border/background match the hamburger button and theme
    // toggle too (colors.surfaceAlt/colors.border), so this reads as a
    // third control in the same row rather than a separate banner.
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tapArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
  },
  percentText: {
    fontSize: 11,
    fontWeight: '600',
  },
  cancelButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '700',
  },
  cancelTextDisabled: {
    opacity: 0.5,
  },
});
