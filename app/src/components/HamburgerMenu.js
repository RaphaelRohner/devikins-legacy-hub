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
 * tabs. Since 11 Oct 2026 the entries are grouped into collapsible
 * categories (Raphael's structure - tap a category to open/close it):
 *
 *   Set Up       Wallets (x), Fetch/Update
 *   Browse NFTs  Devikins, Weapons, Equipment
 *   Tools        Withdrawals, Breeding Helper, KLV Signer (test - Android
 *                app only; signs with the separate KLV Signer app)
 *   Help         Getting started (shows the start checklist again),
 *                Kleverscan, Feedback, Ask Devi, About
 *   Donate       on its own at the bottom (only once a donation address
 *                is set in src/constants/donation.js)
 *
 * Planned entries (Marketplace, Chat, Collectors Album) are added to
 * their category once they exist - not shown before.
 *
 * On the website, Kleverscan opens in a new browser tab and the KLV Signer
 * entry is hidden (both need Android features).
 *
 * Like every other "screen" in this app (see App.js's own file comment),
 * this isn't a real navigation library - it's a plain full-screen Modal
 * (the same component NftCard.js already uses for its fullscreen image
 * viewer) that App.js shows/hides based on a boolean, with each row just
 * calling back up to App.js to say what was tapped.
 */

import { useEffect, useState } from 'react';
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
  onShowGettingStarted,
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
      key: 'withdrawals',
      label: 'Withdrawals',
      screen: 'withdrawals',
      onPress: () => onSelectScreen('withdrawals'),
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
      key: 'guide',
      label: 'Getting started',
      screen: null,
      onPress: () => {
        onClose();
        onShowGettingStarted?.();
      },
    },
    {
      key: 'help',
      label: 'Ask Devi',
      screen: 'help',
      onPress: () => onSelectScreen('help'),
    },
    {
      key: 'about',
      label: 'About',
      screen: 'about',
      onPress: () => onSelectScreen('about'),
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

  // Categories (Raphael, 11 Oct 2026). Collapsible: tap a category to
  // open or close it. Entries for features not built yet (Marketplace,
  // Chat, Collectors Album) get added here once they exist. Donate stays
  // on its own at the bottom.
  const GROUPS = [
    { key: 'setup', title: 'Set Up', entries: ['wallets', 'fetch'] },
    { key: 'browse', title: 'Browse NFTs', entries: ['devikin', 'weapon', 'equipment'] },
    { key: 'tools', title: 'Tools', entries: ['withdrawals', 'breeding', 'signer'] },
    { key: 'help', title: 'Help', entries: ['guide', 'kleverscan', 'feedback', 'help', 'about'] },
  ];
  const entryByKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const groups = GROUPS.map((g) => ({ ...g, items: g.entries.map((k) => entryByKey[k]).filter(Boolean) }));
  const looseEntries = entries.filter((e) => !GROUPS.some((g) => g.entries.includes(e.key)));

  // Which categories are open. When the menu opens, the category of the
  // current screen is opened (others keep how they were left).
  const [openGroups, setOpenGroups] = useState(() => new Set(['browse']));
  useEffect(() => {
    if (!visible) return;
    const current = groups.find((g) => g.items.some((e) => e.screen && e.screen === currentScreen));
    if (current) setOpenGroups((prev) => (prev.has(current.key) ? prev : new Set([...prev, current.key])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, currentScreen]);
  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderEntry(entry, nested) {
    const isActive = entry.screen !== null && entry.screen === currentScreen;
    return (
      <TouchableOpacity
        key={entry.key}
        style={[
          styles.entryRow,
          nested && styles.entryRowNested,
          { backgroundColor: colors.surface, borderColor: colors.border },
          isActive && { borderColor: colors.primary, borderWidth: 2 },
          entry.disabled && styles.entryRowDisabled,
        ]}
        onPress={entry.onPress}
        disabled={entry.disabled}
      >
        <Text style={[styles.entryLabel, nested && styles.entryLabelNested, { color: isActive ? colors.primary : colors.text }]}>
          {entry.label}
        </Text>
      </TouchableOpacity>
    );
  }

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
          {groups.map((group) => {
            const isOpen = openGroups.has(group.key);
            const holdsCurrent = group.items.some((e) => e.screen && e.screen === currentScreen);
            return (
              <View key={group.key} style={styles.group}>
                <TouchableOpacity
                  style={[styles.groupHeader, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                  onPress={() => toggleGroup(group.key)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isOpen }}
                >
                  <Text style={[styles.groupTitle, { color: holdsCurrent ? colors.primary : colors.text }]}>{group.title}</Text>
                  <Text style={[styles.groupChevron, { color: colors.secondaryText }]}>{isOpen ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {isOpen ? <View style={styles.groupItems}>{group.items.map((entry) => renderEntry(entry, true))}</View> : null}
              </View>
            );
          })}
          {looseEntries.map((entry) => renderEntry(entry, false))}
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
  entryRowNested: {
    paddingVertical: 14,
  },
  entryLabelNested: {
    fontSize: 16,
  },
  group: {
    gap: 8,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  groupTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  groupChevron: {
    fontSize: 18,
  },
  groupItems: {
    gap: 8,
    paddingLeft: 16,
  },
  entryRowDisabled: {
    opacity: 0.5,
  },
  entryLabel: {
    fontSize: 17,
    fontWeight: '600',
  },
});
