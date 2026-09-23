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
 * The full detail (exact counts, the specific kind of retry, or the
 * exact error) is still built exactly as before and only shown when
 * the bar is tapped (see `showDetail` below) - there just isn't room
 * for it at a glance. What IS shown at a glance, per feedback, is
 * which collection is currently being worked on - a short "Devikins" /
 * "Weapons" / "Equipment" badge (see `badgeLabel` below) next to the
 * spinner/progress fill, so it's obvious when the scan moves from one
 * collection to the next without needing to tap anything.
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
    // A plain, pre-worded status line - a caller (the background retry
    // timer in App.js) uses this to say up front what kind of work is
    // about to happen (e.g. an NFT refetch vs an image refetch, or the
    // image freshness check) before the per-collection 'fetching'
    // messages below start coming in. Not tied to one collection, so
    // it isn't given the short per-collection badge below either.
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

  // A short, glanceable label for which collection is currently being
  // worked on - "Devikins", "Weapons" or "Equipment" - shown right in
  // the compact bar itself (not just in the tap-to-reveal Alert), so
  // it's obvious when the scan moves from one collection to the next.
  // 'listing'/'fetching'/'error' all carry a per-collection `label`
  // from fetchAllForWallet.js, e.g. "Weapons" or, during a retry,
  // "Weapons (image refetch)" - the parenthetical suffix is stripped
  // here since it's extra detail the Alert already covers and there
  // isn't room for it in this compact a space. 'summary' isn't tied to
  // one collection (see above), so it keeps its own full label instead.
  let badgeLabel = '';
  if (progress.phase === 'summary') {
    badgeLabel = progress.label;
  } else if (progress.label) {
    badgeLabel = progress.label.replace(/\s*\([^)]*\)\s*$/, '');
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
        {badgeLabel ? (
          <Text
            style={[styles.badgeText, { color: colors.text }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {badgeLabel}
          </Text>
        ) : null}

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
  // The short per-collection badge ("Devikins" / "Weapons" /
  // "Equipment") - sized to its own content (no flex) so it doesn't
  // eat into the track/percent next to it during 'fetching', but still
  // shrinks and ellipsizes via numberOfLines/ellipsizeMode above if a
  // longer 'summary' label ever needs to share this same slot.
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
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
