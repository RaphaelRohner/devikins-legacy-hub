/**
 * TabBar.js
 *
 * The three buttons at the top of the results area (Devikins / Weapons /
 * Equipment). This is deliberately NOT using a navigation library like
 * React Navigation - it's just a row of buttons that changes which
 * `activeKind` value the parent (App.js) is holding in state, and App.js
 * decides what to show based on that. For an app this simple, that's
 * easier to understand and debug than adding a whole navigation system.
 */

import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLLECTIONS } from '../constants/schema';
import { useTheme } from '../context/ThemeContext';

export default function TabBar({ activeKind, onSelect }) {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      {Object.keys(COLLECTIONS).map((kind) => {
        const isActive = activeKind === kind;
        return (
          <TouchableOpacity
            key={kind}
            style={[styles.tab, isActive && { borderBottomWidth: 2, borderBottomColor: colors.primary }]}
            onPress={() => onSelect(kind)}
          >
            <Text style={[styles.tabText, { color: isActive ? colors.primary : colors.secondaryText }]}>
              {COLLECTIONS[kind].label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    // Matches App.js's inputColumn side padding (12), so the tabs line
    // up edge-to-edge with the Fetch/Wallets/theme-toggle row above
    // them, rather than the tabs spanning slightly wider than the
    // buttons above - per feedback that the whole top of the app
    // should read as one aligned block. The background/bottom border
    // still span the full screen width either way, since padding only
    // insets this row's children, not the View's own background.
    paddingHorizontal: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabText: {
    // Bold per feedback, so the tab labels (Devikins/Weapons/Equipment)
    // stand out more clearly.
    fontWeight: '700',
  },
});
