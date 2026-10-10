/**
 * HamburgerMenu.js
 *
 * The full-screen navigation menu opened by tapping the ☰ button under
 * the search bar in App.js (see App.js's file comment for the overall
 * V2 layout: search + star filter on top, then this menu's hamburger
 * button underneath, left-aligned).
 *
 * This REPLACES the old TabBar.js (Devikins/Weapons/Equipment tab row)
 * and the old Fetch/Update + Wallets buttons that used to sit above the
 * tabs - all of that is now reached from here instead, as one consistent
 * list of ten entries:
 *
 *   1. Wallets (x)   - opens the Wallets management screen
 *   2. Fetch/Update  - starts a new scan (doesn't change screens)
 *   3. Devikins      - opens the Devikins overview
 *   4. Weapons       - opens the Weapons overview
 *   5. Equipment     - opens the Equipment overview
 *   6. Breeding Helper - opens the Devikins breeding-partner finder
 *   7. Kleverscan      - opens an in-app browser tab on Kleverscan
 *   8. KLV Signer (test) - sends testnet KLV/NFTs, signed by the separate
 *                        KLV Signer app (see SignerTestView.js)
 *   9. Feedback      - opens the feedback form
 *  10. Ask Devi (Help) - opens the offline in-app FAQ helper
 *  11. Donate        - shows the donation address (only once one is set in
 *                      src/constants/donation.js)
 *
 * On the website, Kleverscan opens in a new browser tab and the KLV Signer
 * entry is hidden (both need Android features).
 *
 * Kleverscan sits right after Breeding Helper rather than at the very
 * end (where it first landed) per feedback once it was in daily use -
 * everything through Breeding Helper is a tool about your own
 * collection, and Feedback/Ask Devi are the two "about the app itself"
 * entries; grouping Kleverscan with the collection tools instead of
 * after the app-meta pair keeps that split clean.
 *
 * Like every other "screen" in this app (see App.js's own file comment),
 * this isn't a real navigation library - it's a plain full-screen Modal
 * (the same component NftCard.js already uses for its fullscreen image
 * viewer) that App.js shows/hides based on a boolean, with each row just
 * calling back up to App.js to say what was tapped.
 */

import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Linking, ScrollView } from 'react-native';
import { KLEVERSCAN_URL } from './KleverscanView';
import { DONATION_ADDRESS } from '../constants/donation';

// The website version can't embed Kleverscan or talk to the KLV Signer
// (an Android app), so on the web Kleverscan opens in a new browser tab
// and the Signer entry is left out. The Donate entry appears only once a
// donation address is set in src/constants/donation.js.
const IS_WEB = Platform.OS === 'web';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

export default function HamburgerMenu({
  visible,
  onClose,
  walletCount,
  currentScreen,
  isBusy,
  onSelectWallets,
  onSelectFetch,
  onSelectScreen,
}) {
  const { colors } = useTheme();
  // This is a plain full-screen Modal (see file comment above), not a
  // SafeAreaView-wrapped screen like the rest of the app - Modal content
  // isn't automatically kept clear of the status bar / notch / Dynamic
  // Island the way App.js's own screens are, so it needs its own
  // explicit top inset or the title row sits underneath the system UI
  // (reported after testing on Raphael's phone).
  const insets = useSafeAreaInsets();

  // Each entry: a label (walletCount is spliced into the Wallets one
  // below), which `currentScreen` value it corresponds to (for
  // highlighting - null for Fetch/Update, since that's an action, not a
  // screen), and what to do when tapped.
  const entries = [
    {
      key: 'wallets',
      label: `Wallets${walletCount > 0 ? ` (${walletCount})` : ''}`,
      screen: 'wallets',
      onPress: onSelectWallets,
    },
    {
      key: 'fetch',
      label: isBusy ? 'Fetch/Update (running...)' : 'Fetch/Update',
      screen: null,
      disabled: isBusy,
      onPress: onSelectFetch,
    },
    {
      key: 'devikin',
      label: 'Devikins',
      screen: 'devikin',
      onPress: () => onSelectScreen('devikin'),
    },
    {
      key: 'weapon',
      label: 'Weapons',
      screen: 'weapon',
      onPress: () => onSelectScreen('weapon'),
    },
    {
      key: 'equipment',
      label: 'Equipment',
      screen: 'equipment',
      onPress: () => onSelectScreen('equipment'),
    },
    {
      key: 'breeding',
      label: 'Breeding Helper',
      screen: 'breeding',
      onPress: () => onSelectScreen('breeding'),
    },
    {
      key: 'kleverscan',
      label: 'Kleverscan',
      screen: 'kleverscan',
      onPress: IS_WEB
        ? () => {
            onClose();
            Linking.openURL(KLEVERSCAN_URL);
          }
        : () => onSelectScreen('kleverscan'),
    },
    {
      key: 'signer',
      label: 'KLV Signer (test)',
      screen: 'signer',
      onPress: () => onSelectScreen('signer'),
    },
    {
      key: 'feedback',
      label: 'Feedback',
      screen: 'feedback',
      onPress: () => onSelectScreen('feedback'),
    },
    {
      key: 'help',
      label: 'Ask Devi (Help)',
      screen: 'help',
      onPress: () => onSelectScreen('help'),
    },
    {
      key: 'donate',
      label: 'Donate',
      screen: 'donate',
      onPress: () => onSelectScreen('donate'),
    },
  ].filter((entry) => {
    if (entry.key === 'signer') return !IS_WEB;
    if (entry.key === 'donate') return DONATION_ADDRESS !== '';
    return true;
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 24 }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Menu</Text>
          <TouchableOpacity
            style={[styles.closeButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
            onPress={onClose}
          >
            <Text style={[styles.closeButtonText, { color: colors.text }]}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Scrollable, so every entry stays reachable on short screens
            and small browser windows. */}
        <ScrollView style={styles.entryScroll} contentContainerStyle={styles.entryList}>
          {entries.map((entry) => {
            const isActive = entry.screen !== null && entry.screen === currentScreen;
            return (
              <TouchableOpacity
                key={entry.key}
                style={[
                  styles.entryRow,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  isActive && { borderColor: colors.primary, borderWidth: 2 },
                  entry.disabled && styles.entryRowDisabled,
                ]}
                onPress={entry.onPress}
                disabled={entry.disabled}
              >
                <Text
                  style={[
                    styles.entryLabel,
                    { color: isActive ? colors.primary : colors.text },
                  ]}
                >
                  {entry.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    // paddingTop is set inline above (insets.top + 24) so it accounts
    // for the device's actual status bar / notch height, not just a
    // fixed guess - see the insets comment near the top of this file.
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    fontSize: 18,
    fontWeight: '600',
  },
  entryScroll: {
    flex: 1,
  },
  entryList: {
    gap: 12,
    paddingBottom: 24,
  },
  entryRow: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 18,
    paddingHorizontal: 16,
  },
  entryRowDisabled: {
    opacity: 0.5,
  },
  entryLabel: {
    fontSize: 17,
    fontWeight: '600',
  },
});
