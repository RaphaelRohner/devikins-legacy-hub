/**
 * NftHistoryModal.js
 *
 * "Changelog" for one NFT - what CollectionView.js's floating Changelog
 * button (see its own JSX comment) opens. Same bottom-sheet Modal
 * pattern SortPickerModal.js already uses (dim, tappable backdrop; a
 * rounded sheet sliding up from the bottom; tap outside to dismiss) -
 * deliberately reused rather than inventing a new presentation, since
 * this is just as lightweight a "pick one thing off a short list and
 * move on" screen as that one is.
 *
 * Purely presentational, same as SortPickerModal.js: CollectionView.js
 * owns fetching the raw rows (see getNftHistory in database.js) and
 * just hands them down as `entries`, in whatever order that query
 * already returns them (newest first).
 *
 * The one thing this file does own: grouping. A single fetch can catch
 * more than one real trait change at once (say Procreations Left AND
 * Life Stage both moved since the last time this NFT was seen) -
 * upsertNft logs those as separate nft_history rows, but every one of
 * them shares the exact same `changed_at` value, since it's stamped
 * once per fetch, not once per field (see upsertNft's own comment).
 * That shared timestamp is what groupEntries below keys off of, so a
 * fetch that caught three changes reads as one dated entry listing all
 * three, rather than three disconnected lines that happen to have
 * identical timestamps - meaningfully easier to read as "what happened
 * over time" instead of "here's a pile of individual field edits". The
 * rows are already ordered oldest-to-newest WITHIN a shared timestamp
 * from the query (id DESC as the tiebreaker) and newest-timestamp-first
 * overall, so a single pass over them (comparing each row only to the
 * group currently being built) is enough - no separate sort needed here.
 */

import { Modal, ScrollView, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { humanizeColumnName } from './FilterPanel';
import { useTheme } from '../context/ThemeContext';

function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.changedAt === entry.changed_at) {
      lastGroup.changes.push(entry);
    } else {
      groups.push({ changedAt: entry.changed_at, changes: [entry] });
    }
  }
  return groups;
}

// e.g. "Sep 20, 2026, 3:45 PM" - date and time both matter here, since
// more than one of these can land on the same day once retries/re-
// fetches are involved, and just the date alone wouldn't tell those
// apart.
function formatChangedAt(changedAt) {
  const date = new Date(changedAt);
  const datePart = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timePart = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

// null/undefined only ever shows up as the OLD side of a change (see
// getNftHistory's own comment on upsertNft never logging a change TO a
// missing value) - a trait this NFT simply didn't have a stored value
// for yet, before this fetch gave it one.
function formatValue(value) {
  return value === null || value === undefined ? '(none)' : value;
}

export default function NftHistoryModal({ visible, entries, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = groupEntries(entries);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 }]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Changelog</Text>
            <Text style={[styles.hint, { color: colors.secondaryText }]}>
              Every real change this app has caught on a fetch, newest first.
            </Text>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {groups.map((group) => (
              <View key={group.changedAt} style={[styles.group, { borderBottomColor: colors.border }]}>
                <Text style={[styles.groupDate, { color: colors.secondaryText }]}>
                  {formatChangedAt(group.changedAt)}
                </Text>
                {group.changes.map((change) => (
                  <Text key={change.field_name} style={[styles.changeLine, { color: colors.text }]}>
                    {humanizeColumnName(change.field_name)}: {formatValue(change.old_value)} → {formatValue(change.new_value)}
                  </Text>
                ))}
              </View>
            ))}
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
    paddingBottom: 8,
  },
  group: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupDate: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  changeLine: {
    fontSize: 14,
    lineHeight: 20,
  },
});
