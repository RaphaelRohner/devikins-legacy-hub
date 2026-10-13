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
 * Each row has its own ↑ and ↓ buttons: one tap picks the field and the
 * direction, and the sheet closes (13 Oct 2026). Tapping the field name
 * itself uses that field's usual direction (see App.js's
 * handleSelectSortField). ✕ closes without changing anything.
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
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.text }]}>Sort by</Text>
              <Text style={[styles.hint, { color: colors.secondaryText }]}>
                Tap ↑ (lowest first) or ↓ (highest first) next to a field.
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.closeButton, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
              onPress={onClose}
              accessibilityLabel="Close"
            >
              <Text style={[styles.closeButtonText, { color: colors.text }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {fields.map((field) => {
              const isActive = field.name === sortField;
              const arrowButton = (direction, symbol) => {
                const isChosen = isActive && sortDirection === direction;
                return (
                  <TouchableOpacity
                    key={direction}
                    style={[
                      styles.arrowButton,
                      { borderColor: isChosen ? colors.primary : colors.border },
                      isChosen && { backgroundColor: colors.primary },
                    ]}
                    onPress={() => onSelect(field.name, direction)}
                    accessibilityLabel={`${field.label} ${direction === 'asc' ? 'ascending' : 'descending'}`}
                  >
                    <Text style={[styles.arrowText, { color: isChosen ? colors.primaryText : colors.text }]}>{symbol}</Text>
                  </TouchableOpacity>
                );
              };
              return (
                <View key={field.name} style={[styles.row, { borderBottomColor: colors.border }]}>
                  <TouchableOpacity style={styles.rowNameButton} onPress={() => onSelect(field.name)}>
                    <Text
                      style={[
                        styles.rowLabel,
                        { color: isActive ? colors.primary : colors.text },
                        isActive && styles.rowLabelActive,
                      ]}
                    >
                      {field.label}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.arrowGroup}>
                    {arrowButton('asc', '↑')}
                    {arrowButton('desc', '↓')}
                  </View>
                </View>
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
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  closeButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
  rowNameButton: {
    flex: 1,
    paddingVertical: 4,
  },
  arrowGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  arrowButton: {
    width: 44,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    fontSize: 18,
    fontWeight: '700',
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
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontSize: 15,
  },
  rowLabelActive: {
    fontWeight: '700',
  },
});
