/**
 * SortPickerModal.js
 *
 * The picker that opens from App.js's new Sort button (next to the
 * List/Tiles toggle, above the current collection's list) - a small
 * sheet listing every field this collection can be sorted by, rather
 * than a full-screen "subpage" of its own. Purely presentational: it
 * doesn't know what a valid field is, or what happens when one's
 * picked - App.js owns the actual sortField/sortDirection state and
 * passes down `fields` (already scoped to whichever collection is
 * currently showing - see App.js's sortFieldOptions) plus the current
 * selection.
 *
 * Tapping a field that isn't the current one picks it (App.js gives it
 * a sensible starting direction - see handleSelectSortField there).
 * Tapping the field that's ALREADY active flips its direction instead -
 * same onSelect callback either way, App.js decides which happened by
 * comparing the tapped name to the current sortField.
 *
 * Deliberately only covers part of the screen (see `sheet` below, not
 * a full-screen Modal like QrScannerModal.js) with a dim, tappable
 * backdrop rather than its own close button - the collection list
 * keeps updating live underneath as different fields are tried, so
 * there's something to actually see change while this is open, and
 * tapping anywhere outside the sheet dismisses it once you're happy
 * with the result.
 */

import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

export default function SortPickerModal({ visible, fields, sortField, sortDirection, onSelect, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        {/* Swallows taps so they don't fall through to the backdrop
            above and close the sheet while someone's actually using it -
            the same "stopPropagation via a second TouchableOpacity"
            trick used anywhere else in this app a tappable overlay sits
            on top of a tappable background. */}
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 }]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Sort by</Text>
            <Text style={[styles.hint, { color: colors.secondaryText }]}>
              Tap a field to sort by it - tap it again to flip the order.
            </Text>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {fields.map((field) => {
              const isActive = field.name === sortField;
              return (
                <TouchableOpacity
                  key={field.name}
                  style={[styles.row, { borderBottomColor: colors.border }]}
                  onPress={() => onSelect(field.name)}
                >
                  <Text
                    style={[
                      styles.rowLabel,
                      { color: isActive ? colors.primary : colors.text },
                      isActive && styles.rowLabelActive,
                    ]}
                  >
                    {field.label}
                  </Text>
                  {isActive && (
                    <Text style={[styles.rowArrow, { color: colors.primary }]}>
                      {sortDirection === 'asc' ? '↑ Ascending' : '↓ Descending'}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '65%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  hint: {
    fontSize: 12,
    marginTop: 2,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontSize: 15,
  },
  rowLabelActive: {
    fontWeight: '700',
  },
  rowArrow: {
    fontSize: 13,
    fontWeight: '600',
  },
});
