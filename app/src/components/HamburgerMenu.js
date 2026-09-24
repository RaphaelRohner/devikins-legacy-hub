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
 * list of nine entries:
 *
 *   1. Wallets (x)   - opens the Wallets management screen
 *   2. Fetch/Update  - starts a new scan (doesn't change screens)
 *   3. Devikins      - opens the Devikins overview
 *   4. Weapons       - opens the Weapons overview
 *   5. Equipment     - opens the Equipment overview
 *   6. Breeding Helper - opens the Devikins breeding-partner finder
 *   7. Kleverscan      - opens an in-app browser tab on Kleverscan
 *   8. Feedback      - opens the feedback form
 *   9. Ask Devi (Help) - opens the offline in-app FAQ helper
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

import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
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
      onPress: () => onSelectScreen('kleverscan'),
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
  ];

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

        <View style={styles.entryList}>
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
        </View>
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
  entryList: {
    gap: 12,
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
