/**
 * ProgressBar.js
 *
 * Shows what's happening while fetchAllForWallet.js is running: which
 * collection is currently being worked on, how many NFTs are done out of
 * how many total, and a Stop button. This exists specifically so a big
 * wallet fetch (which can take a while, since the metadata server is slow)
 * never looks like the app has frozen.
 *
 * `progress` is whatever fetchAllForWallet.js's onProgress callback most
 * recently received - see that file for the exact shape.
 */

import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
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
    // A plain, pre-worded status line - used by the background retry
    // timer (see App.js) to say up front what kind of work a round is
    // about to do (an NFT refetch vs an image refetch), before the
    // per-collection 'fetching' messages below start coming in.
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

  return (
    <View style={[styles.container, { backgroundColor: colors.progressBackground }]}>
      <Text style={[styles.message, { color: colors.progressText }]}>{message}</Text>

      {fractionComplete !== null && (
        <View style={[styles.track, { backgroundColor: colors.progressTrack }]}>
          <View style={[styles.fill, { width: `${Math.round(fractionComplete * 100)}%`, backgroundColor: colors.primary }]} />
        </View>
      )}

      <TouchableOpacity
        onPress={onCancel}
        disabled={isCancelling}
        style={[styles.cancelButton, isCancelling && styles.cancelButtonDisabled]}
      >
        <Text style={[styles.cancelText, { color: colors.cancelText }]}>
          {isCancelling ? 'Stopping...' : 'Stop'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 12,
    borderRadius: 8,
    margin: 12,
  },
  message: {
    marginBottom: 6,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
  },
  cancelButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  cancelButtonDisabled: {
    opacity: 0.5,
  },
  cancelText: {
    fontWeight: '600',
  },
});
