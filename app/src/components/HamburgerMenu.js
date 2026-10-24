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
 *   Set Up       Getting started (the start checklist), Wallets (x),
 *                Fetch/Update, Kleverscan (find a wallet to try the Hub)
 *   Browse NFTs  Devikins, Weapons, Equipment, Where are my NFTs?
 *   Features     Chat (website only for now, since 22 Oct 2026),
 *                Withdrawals, Breeding Helper, KLV Signer (test - Android
 *                app only; signs with the separate KLV Signer app)
 *   Help         Ask Devi, Feedback, About
 * A closed category shows a grey line listing what's inside (16 Oct 2026).
 *   Donate       on its own at the bottom (only once a donation address
 *                is set in src/constants/donation.js)
 *
 * Planned entries (Marketplace, Collectors Album) are added to
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

import { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Linking, ScrollView } from 'react-native';
import { KLEVERSCAN_URL } from './KleverscanView';
import { DONATION_ADDRESS } from '../constants/donation';

// The website version can't embed Kleverscan or talk to the KLV Signer
// (an Android app), so on the web Kleverscan opens in a new browser tab
// and the Signer entry is left out. The Donate entry appears only once a
// donation address is set in src/constants/donation.js.
const IS_WEB = Platform.OS === 'web';
import { shortcutFor, showShortcutsHelp } from '../web/shortcuts';
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
  chatUnread = 0,
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
      shortLabel: 'Wallets',
      screen: 'wallets',
      onPress: onSelectWallets,
    },
    {
      key: 'fetch',
      shortcut: 'fetch',
      label: isBusy ? 'Fetch/Update (running...)' : 'Fetch/Update',
      shortLabel: 'Fetch/Update',
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
      key: 'overview',
      label: 'Where are my NFTs?',
      hint: 'How many in each wallet',
      screen: 'overview',
      onPress: () => onSelectScreen('overview'),
    },
    {
      key: 'breeding',
      label: 'Breeding Helper',
      screen: 'breeding',
      onPress: () => onSelectScreen('breeding'),
    },
    {
      key: 'chat',
      label: chatUnread > 0 ? `Chat (${chatUnread})` : 'Chat',
      shortLabel: 'Chat',
      hint: 'Talk to other players (new)',
      screen: 'chat',
      onPress: () => onSelectScreen('chat'),
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
      // Why it's in Set Up: a quick way to pick a holder's address and try
      // the Hub without a wallet of your own (Raphael, 16 Oct 2026).
      hint: 'Find a wallet to try the Hub with',
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
    // The chat starts on the website; the phone app gets it later.
    if (entry.key === 'chat') return IS_WEB;
    if (entry.key === 'donate') return DONATION_ADDRESS !== '';
    return true;
  });

  // Categories (Raphael, 11 Oct 2026). Collapsible: tap a category to
  // open or close it. Entries for features not built yet (Marketplace,
  // Chat, Collectors Album) get added here once they exist. Donate stays
  // on its own at the bottom.
  const GROUPS = [
    // 16 Oct 2026 (Raphael): Getting started opens Set Up; Kleverscan moved
    // there as a quiet extra; "Tools" became "Features" (a tester would
    // "never have looked under Tools" for the Breeding Helper).
    { key: 'setup', title: 'Set Up', entries: ['guide', 'wallets', 'fetch', 'kleverscan'] },
    { key: 'browse', title: 'Browse NFTs', entries: ['devikin', 'weapon', 'equipment', 'overview'] },
    { key: 'features', title: 'Features', entries: ['chat', 'withdrawals', 'breeding', 'signer'] },
    { key: 'help', title: 'Help', entries: ['help', 'feedback', 'about'] },
  ];
  const entryByKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const groups = GROUPS.map((g) => ({ ...g, items: g.entries.map((k) => entryByKey[k]).filter(Boolean) }));
  const looseEntries = entries.filter((e) => !GROUPS.some((g) => g.entries.includes(e.key)));

  // Which categories are open. Every time the menu opens, it starts tidy:
  // only the category of the current screen is open, the rest are closed.
  // This is decided while the menu is being drawn (not a moment later),
  // so a quick tap on a category right after opening is never undone.
  const currentGroupKey = groups.find((g) => g.items.some((e) => e.screen && e.screen === currentScreen))?.key;
  const [openGroups, setOpenGroups] = useState(() => new Set(currentGroupKey ? [currentGroupKey] : []));
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setOpenGroups(new Set(currentGroupKey ? [currentGroupKey] : []));
  }
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
        <View style={styles.entryLabelRow}>
          <Text style={[styles.entryLabel, nested && styles.entryLabelNested, { color: isActive ? colors.primary : colors.text, flexShrink: 1 }]}>
            {entry.label}
          </Text>
          {/* The keyboard shortcut (website only - src/web/shortcuts.js) */}
          {IS_WEB && shortcutFor(entry.shortcut || entry.screen) ? (
            <Text style={[styles.entryShortcut, { color: colors.secondaryText, borderColor: colors.border }]}>
              {shortcutFor(entry.shortcut || entry.screen)}
            </Text>
          ) : null}
        </View>
        {entry.hint ? (
          <Text style={[styles.entryHint, { color: colors.secondaryText }]} numberOfLines={1}>
            {entry.hint}
          </Text>
        ) : null}
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
                  <View style={styles.groupTitleBox}>
                    <Text style={[styles.groupTitle, { color: holdsCurrent ? colors.primary : colors.text }]}>{group.title}</Text>
                    {/* While closed, a grey line says what's inside, so nobody
                        has to guess what a heading holds (16 Oct 2026). */}
                    {!isOpen ? (
                      <Text style={[styles.groupContents, { color: colors.secondaryText }]} numberOfLines={1}>
                        {group.items.map((e) => e.shortLabel || e.label).join(', ')}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.groupChevron, { color: colors.secondaryText }]}>{isOpen ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {isOpen ? <View style={styles.groupItems}>{group.items.map((entry) => renderEntry(entry, true))}</View> : null}
              </View>
            );
          })}
          {looseEntries.map((entry) => renderEntry(entry, false))}
          {IS_WEB ? (
            <TouchableOpacity
              onPress={() => {
                onClose();
                showShortcutsHelp();
              }}
              style={styles.shortcutsLink}
              testID="menu-shortcuts"
            >
              <Text style={[styles.entryHint, { color: colors.secondaryText }]}>⌨ Keyboard shortcuts: press ? anywhere</Text>
            </TouchableOpacity>
          ) : null}
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
  groupTitleBox: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  groupContents: {
    fontSize: 13,
    marginTop: 2,
  },
  entryHint: {
    fontSize: 13,
    marginTop: 2,
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
  entryLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  entryShortcut: { fontSize: 12, fontWeight: '700', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  shortcutsLink: { alignSelf: 'center', paddingVertical: 10 },
  entryLabel: {
    fontSize: 17,
    fontWeight: '600',
  },
});
