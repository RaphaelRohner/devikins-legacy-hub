/**
 * KleverscanView.js
 *
 * A small in-app browser tab pointed at Kleverscan (Klever's own block
 * explorer), opened straight to the Devikins collection's asset page
 * (assetId DVKNFT-1SW5, from COLLECTIONS.devikin in schema.js - the
 * same id the app's own API calls already use, so this can never drift
 * out of sync with a hand-copied URL) rather than a blank search box -
 * a quick way to check holder counts, supply, and on-chain activity
 * without leaving the app or hunting down the right asset ID by hand.
 *
 * Uses react-native-webview (confirmed "Included in Expo Go" before
 * adding it as a dependency - no custom dev build needed, same
 * Expo-Go-compatible bar every other native module in this app was
 * picked against) rather than expo-web-browser's openBrowserAsync,
 * since that opens as a separate system browser sheet layered on top of
 * the app rather than a real screen - Raphael asked for "a tab," which
 * this matches instead: the exact same full-screen-takeover pattern as
 * every other screen here (WalletManager.js/Feedback.js/HelpAssistant.js/
 * BreedingHelper.js), with its own "‹" back button, rendered by App.js
 * the same way (currentScreen === 'kleverscan').
 *
 * Also adds a plain back/forward/reload row above the page itself -
 * without it, tapping any link on Kleverscan (into a wallet address, a
 * transaction, the fungible DVK token, etc.) would strand you there
 * with no way back except leaving the tab entirely and losing your
 * place. canGoBack/canGoForward come straight from the WebView's own
 * onNavigationStateChange callback, so these buttons disable themselves
 * correctly rather than always appearing tappable.
 */

import { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../context/ThemeContext';
import { COLLECTIONS } from '../constants/schema';

const KLEVERSCAN_URL = `https://kleverscan.org/asset/${COLLECTIONS.devikin.assetId}`;

export default function KleverscanView({ onClose }) {
  const { colors } = useTheme();
  const webViewRef = useRef(null);
  // Start both false (safe default before the first onNavigationStateChange
  // fires) rather than guessing - a same-tick flash of an enabled-but-
  // useless Back/Forward button on first render is harmless either way,
  // but false is the honest starting answer: nothing to go back/forward
  // to yet.
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity
          style={[styles.backButton, { backgroundColor: colors.primary }]}
          onPress={onClose}
        >
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          Kleverscan
        </Text>
        <View style={styles.navButtons}>
          <TouchableOpacity
            style={[
              styles.navButton,
              { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              !canGoBack && styles.navButtonDisabled,
            ]}
            onPress={() => webViewRef.current?.goBack()}
            disabled={!canGoBack}
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>◀</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.navButton,
              { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              !canGoForward && styles.navButtonDisabled,
            ]}
            onPress={() => webViewRef.current?.goForward()}
            disabled={!canGoForward}
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>▶</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
            onPress={() => webViewRef.current?.reload()}
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>⟳</Text>
          </TouchableOpacity>
        </View>
      </View>

      <WebView
        ref={webViewRef}
        source={{ uri: KLEVERSCAN_URL }}
        style={styles.webview}
        onNavigationStateChange={(navState) => {
          setCanGoBack(navState.canGoBack);
          setCanGoForward(navState.canGoForward);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginVertical: 12,
    gap: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
  },
  navButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  navButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  webview: {
    flex: 1,
  },
});
