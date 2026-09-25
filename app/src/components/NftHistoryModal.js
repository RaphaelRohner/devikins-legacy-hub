/**
 * NftHistoryModal.js
 *
 * "Changelog" for one NFT - what CollectionView.js's Changelog button
 * (in its detail view's header row, next to the back button) opens.
 * Same bottom-sheet Modal pattern SortPickerModal.js already uses (dim,
 * tappable backdrop; a rounded sheet sliding up from the bottom; tap
 * outside to dismiss) - deliberately reused rather than inventing a new
 * presentation, since this is just as lightweight a "pick one thing off
 * a short list and move on" screen as that one is.
 *
 * Mostly presentational, same as SortPickerModal.js: CollectionView.js
 * owns fetching the raw rows (see getNftHistory in database.js) and
 * just hands them down as `entries`, in whatever order that query
 * already returns them (newest first) - plus `kind`, used only to pick
 * this item's field display order below.
 *
 * Two things this file owns: grouping and field order.
 *
 * Grouping: a single fetch can catch more than one real trait change at
 * once (say Procreations Left AND Life Stage both moved since the last
 * time this NFT was seen) - upsertNft logs those as separate
 * nft_history rows, but every one of them shares the exact same
 * `changed_at` value, since it's stamped once per fetch, not once per
 * field (see upsertNft's own comment). That shared timestamp is what
 * groupEntries below keys off of, so a fetch that caught three changes
 * reads as one dated entry listing all three, rather than three
 * disconnected lines that happen to have identical timestamps -
 * meaningfully easier to read as "what happened over time" instead of
 * "here's a pile of individual field edits".
 *
 * Field order: within a group, fields used to just print in whatever
 * order the SQL query happened to return them in (id DESC as the
 * tiebreaker - incidentally the reverse of upsertNft's own trait-column
 * iteration order, never an intentional design). Per Raphael's own
 * feedback after his first real weapon test, that's now an explicit
 * per-kind order instead (see getFieldOrder below) - e.g. weapons show
 * Rarity first and Improvement Level last, regardless of which order
 * upsertNft happened to write them in for a given fetch.
 */

import { useMemo } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { humanizeColumnName } from './FilterPanel';
import { useTheme } from '../context/ThemeContext';
import { TRAIT_COLUMNS } from '../constants/schema';

// Changelog-specific field order overrides, keyed by kind. Everything
// else in the app (Filters, sort options, ...) reads TRAIT_COLUMNS in
// its own schema.js definition order, and that's still the default
// here too - an override only needs to name whichever fields are
// actually being pulled out of that default position, not re-list
// every trait. Weapons are the only kind with one so far: Rarity and
// Slot pinned to the front, Improvement Level pinned to the back,
// exactly as Raphael asked for after seeing the (previously accidental)
// default order in practice.
const FIELD_ORDER_FRONT = {
  weapon: ['rarity', 'slot'],
};
const FIELD_ORDER_BACK = {
  weapon: ['improvement_level'],
};

// Builds one kind's full Changelog field order: whatever's pinned to
// the front (in the order given above), then every other trait in
// schema.js's own natural order, then whatever's pinned to the back.
function getFieldOrder(kind) {
  const naturalOrder = Object.keys(TRAIT_COLUMNS[kind] || {});
  const front = FIELD_ORDER_FRONT[kind] || [];
  const back = FIELD_ORDER_BACK[kind] || [];
  const pinned = new Set([...front, ...back]);
  const middle = naturalOrder.filter((columnName) => !pinned.has(columnName));
  return [...front, ...middle, ...back];
}

function groupEntries(entries, fieldOrder) {
  const groups = [];
  for (const entry of entries) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.changedAt === entry.changed_at) {
      lastGroup.changes.push(entry);
    } else {
      groups.push({ changedAt: entry.changed_at, changes: [entry] });
    }
  }
  // Sorted by fieldOrder rather than left in the query's own id-based
  // order - see this file's header comment. A field_name that isn't in
  // fieldOrder (shouldn't normally happen - every logged field comes
  // from TRAIT_COLUMNS) sorts after everything that is, rather than
  // crashing or silently landing at the top.
  for (const group of groups) {
    group.changes.sort((a, b) => {
      const indexA = fieldOrder.indexOf(a.field_name);
      const indexB = fieldOrder.indexOf(b.field_name);
      return (indexA === -1 ? Infinity : indexA) - (indexB === -1 ? Infinity : indexB);
    });
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

export default function NftHistoryModal({ visible, entries, onClose, kind }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fieldOrder = useMemo(() => getFieldOrder(kind), [kind]);
  const groups = groupEntries(entries, fieldOrder);

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
