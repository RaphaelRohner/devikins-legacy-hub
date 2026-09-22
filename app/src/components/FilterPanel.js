/**
 * FilterPanel.js
 *
 * Renders the actual filter controls (dropdowns for categorical traits,
 * min/max boxes for numeric traits) for whichever collection tab is
 * showing. This is the SCROLLABLE part of filtering - CollectionView.js
 * passes this component into its results list's `ListHeaderComponent`
 * (and only while the panel is expanded), so these rows scroll together
 * with the results underneath them.
 *
 * The pinned "Show/Hide filters" toggle and "Apply/Remove Filters"
 * button live in CollectionView.js instead, rendered as a fixed bar
 * above the list - a plain sibling of the list, outside any scrolling
 * area, so it never moves no matter how far you scroll or how many
 * filter rows there are. See CollectionView.js's file comment for the
 * full reasoning.
 *
 * Because the toggle/button and these rows need to share the same
 * picks, all of the filter STATE (which options are available, what's
 * picked but not yet applied) now lives in CollectionView.js and is
 * simply passed down here as props. This component itself holds no
 * state - it just draws the rows and reports changes upward.
 *
 * Filter options are still DERIVED from what's actually in the database
 * for this wallet (loaded in CollectionView.js now) - e.g. if this
 * wallet's Weapons happen to all be "Common" rarity, the Rarity dropdown
 * will only offer "Common", not every possible rarity.
 *
 * One row is different: the star-rating filter at the top (starFilter/
 * onStarFilterChange props) isn't derived from the database like the
 * rows below it are - its options are just a fixed row of 5 stars. It
 * IS part of the same pending/Apply flow those rows use, though: what's
 * passed in here is CollectionView.js's own `pendingStarFilter`, not
 * the applied value straight from App.js, so tapping a star only
 * updates the pending pick - it takes effect (and bubbles up to
 * App.js, where the applied value lives so it can carry over between
 * Devikins/Weapons/Equipment) only once "Apply Filters" is pressed,
 * same as every filter below it. This used to apply the instant you
 * tapped a star; per feedback that was confusing next to filters that
 * all wait for Apply, so it was folded into the same flow - see
 * CollectionView.js's own file comment for the full reasoning.
 */

import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useTheme } from '../context/ThemeContext';
import StarRating from './StarRating';

// Turns a database column name (snake_case, e.g. "improvement_level")
// into a readable filter label ("Improvement Level"). Exported because
// CollectionView.js's empty-state message ("No X NFTs match the
// filter(s): ...") needs to describe the same applied filters using
// the same labels shown on these rows.
export function humanizeColumnName(columnName) {
  return columnName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// A sentinel value for the Picker's "no filter selected" option. Can't
// use an empty string or null directly as a Picker.Item value in a fully
// reliable cross-platform way, so we use this distinct marker instead and
// translate it back to "no filter" ourselves. Exported because
// CollectionView.js (which now owns the filter state) needs to compare
// against it too.
export const NO_FILTER = '__ALL__';

export default function FilterPanel({ availableOptions, pendingFilters, onTextFilterChange, onRangeFilterChange, starFilter = 0, onStarFilterChange }) {
  const { colors } = useTheme();
  const filterableColumnNames = Object.keys(availableOptions);

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceAlt }]}>
      <View style={[styles.filterRow, styles.starFilterRow, { borderBottomColor: colors.border }]}>
        <Text style={[styles.filterLabel, { color: colors.text }]}>Rating (exact match)</Text>
        <StarRating value={starFilter} onChange={onStarFilterChange} size={22} />
      </View>
      {filterableColumnNames.map((columnName) => {
        const option = availableOptions[columnName];
        const label = humanizeColumnName(columnName);

        if (option.kind === 'text') {
          return (
            <View key={columnName} style={styles.filterRow}>
              <Text style={[styles.filterLabel, { color: colors.text }]}>{label}</Text>
              <View style={[styles.pickerWrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Picker
                  selectedValue={pendingFilters[columnName] ?? NO_FILTER}
                  onValueChange={(value) => onTextFilterChange(columnName, value)}
                  style={{ color: colors.text }}
                  dropdownIconColor={colors.text}
                >
                  <Picker.Item label="All" value={NO_FILTER} />
                  {option.values.map((value) => (
                    <Picker.Item key={value} label={String(value)} value={value} />
                  ))}
                </Picker>
              </View>
            </View>
          );
        }

        // Numeric range filter. Note there's no keyboardType="numeric"
        // here on purpose - some traits (Speed Modifier, Accuracy) can be
        // negative, and the numeric-only keyboard on iOS has no minus
        // sign, which would make it impossible to type a negative number.
        // The default keyboard is slightly less convenient but always
        // lets you type "-".
        return (
          <View key={columnName} style={styles.filterRow}>
            <Text style={[styles.filterLabel, { color: colors.text }]}>
              {label} (found: {option.min} to {option.max})
            </Text>
            <View style={styles.rangeRow}>
              <TextInput
                style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                placeholder="min"
                placeholderTextColor={colors.secondaryText}
                value={pendingFilters[columnName]?.min ?? ''}
                onChangeText={(text) => onRangeFilterChange(columnName, 'min', text)}
              />
              <Text style={[styles.rangeSeparator, { color: colors.secondaryText }]}>to</Text>
              <TextInput
                style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                placeholder="max"
                placeholderTextColor={colors.secondaryText}
                value={pendingFilters[columnName]?.max ?? ''}
                onChangeText={(text) => onRangeFilterChange(columnName, 'max', text)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  filterRow: {
    marginBottom: 10,
  },
  starFilterRow: {
    paddingBottom: 10,
    marginBottom: 14,
    borderBottomWidth: 1,
  },
  filterLabel: {
    fontSize: 13,
    marginBottom: 2,
  },
  pickerWrapper: {
    borderRadius: 6,
    borderWidth: 1,
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rangeInput: {
    flex: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
  },
  rangeSeparator: {
    color: '#999',
  },
});
