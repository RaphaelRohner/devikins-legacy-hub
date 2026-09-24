/**
 * CompareView.js
 *
 * Full-screen side-by-side comparison of two NFTs of the same kind -
 * every stat/trait this kind has (see TRAIT_COLUMNS in
 * src/constants/schema.js), not a curated subset. This is the
 * lightweight version of "compare two NFTs" that was actually asked
 * for: reached from CollectionView.js's own new "Compare" toggle (the
 * ⇄ button next to List/Tiles) rather than a separate guided picker
 * screen with its own filter panel - turning Compare on switches row
 * taps from "open detail view" to "select for compare" (up to two,
 * highlighted with a colored border - see CollectionView.js's own
 * `selected` prop on the summary row / tile components), and picking a
 * second item opens straight into this screen, no extra "Compare now"
 * tap needed.
 *
 * Deliberately reuses whatever list you already had filtered/sorted/
 * searched in CollectionView.js - this screen itself has no filter
 * controls of its own, just the two NFTs you picked. "‹" returns to
 * that same list with the selection cleared, ready to pick two
 * different items (see CollectionView.js's handleCloseCompare).
 *
 * Every stat is shown by default, not a hand-picked subset, per
 * Raphael's own call on this - may well grow into something more
 * curated later once this has been used for a while. The one exception
 * is the "Show differences only" toggle next to the title: switching
 * it on hides any stat both NFTs agree on, since those aren't useful
 * when the whole point is deciding which one to keep. A stat where
 * BOTH sides are blank (null/undefined) counts as "agreeing" too, same
 * as any other matching value, per Raphael's own call - only one side
 * being blank is treated as a real difference. If every stat happens
 * to match, a plain message says so instead of leaving the screen
 * looking broken/empty. The toggle itself matches CollectionView.js's
 * own Deleted switch (deletedSwitchGroup/deletedSwitchLabel) - same
 * bordered-pill-with-label-and-native-Switch look, just relocated
 * here.
 */

import { useState } from 'react';
import { Image, ScrollView, Switch, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { TRAIT_COLUMNS } from '../constants/schema';
import { humanizeColumnName } from './FilterPanel';
import { useTheme } from '../context/ThemeContext';

// Small standalone thumbnail, same "prefer the locally-saved copy, fall
// back to a clearly-labeled placeholder" logic every other thumbnail in
// this app uses (see DevikinSummaryRow.js/NftCard.js) - kept local
// rather than shared since it's this screen's only use of an image and
// every other screen with one (BreedingHelper.js, the summary rows)
// already does the same thing.
function Thumbnail({ nft, colors }) {
  const imageSource = nft.local_image_path || nft.image;
  if (!imageSource) {
    return (
      <View style={[styles.thumbnail, styles.thumbnailPlaceholder, { backgroundColor: colors.placeholderBackground }]}>
        <Text style={[styles.thumbnailPlaceholderText, { color: colors.placeholderText }]}>Unavailable</Text>
      </View>
    );
  }
  return <Image source={{ uri: imageSource }} style={styles.thumbnail} resizeMode="contain" />;
}

// One side of the comparison - a header (thumbnail, ID, name) followed
// by every trait this kind has, in TRAIT_COLUMNS' own declared order so
// both sides always line up row-for-row regardless of which traits
// either NFT actually has a value for.
function CompareColumn({ nft, colors, traitColumns }) {
  return (
    <View style={styles.compareColumn}>
      <Thumbnail nft={nft} colors={colors} />
      <Text style={[styles.idLine, { color: colors.secondaryText }]} numberOfLines={1}>
        #{nft.nonce}{nft.custom_name ? ` · ${nft.custom_name}` : ''}
      </Text>
      <Text style={[styles.nameLine, { color: colors.text }]} numberOfLines={2}>
        {nft.name || '—'}
      </Text>
      {traitColumns.map((columnName) => (
        <Text key={columnName} style={[styles.traitLine, { color: colors.text }]}>
          {humanizeColumnName(columnName)}: {nft[columnName] ?? '—'}
        </Text>
      ))}
    </View>
  );
}

export default function CompareView({ kind, nfts, onClose }) {
  const { colors } = useTheme();
  const [nftA, nftB] = nfts;
  const [showDifferencesOnly, setShowDifferencesOnly] = useState(false);

  // Every trait this kind has that's meant to be user-facing - the same
  // `filterable !== false` rule NftCard.js's own full detail view and
  // getSortableFieldNames (schema.js) already use, so this list matches
  // what you'd see if you tapped into either NFT's own detail view,
  // just both sides at once. Rarity's included here too, same as every
  // other trait - no special-casing needed.
  const traitColumns = Object.keys(TRAIT_COLUMNS[kind]).filter(
    (columnName) => TRAIT_COLUMNS[kind][columnName].filterable !== false
  );

  // With the toggle on, drop any column both sides agree on - null and
  // undefined are normalized to the same value first, so two blanks
  // count as "agreeing" (nothing to compare there) rather than showing
  // up as a difference just because one side is stored as null and the
  // other undefined.
  const displayedTraitColumns = showDifferencesOnly
    ? traitColumns.filter((columnName) => (nftA[columnName] ?? null) !== (nftB[columnName] ?? null))
    : traitColumns;
  const noDifferences = showDifferencesOnly && displayedTraitColumns.length === 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>Compare</Text>
        <View style={[styles.differencesSwitchGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.differencesSwitchLabel, { color: colors.text }]}>Show differences only</Text>
          <Switch
            value={showDifferencesOnly}
            onValueChange={setShowDifferencesOnly}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor={colors.surface}
          />
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {noDifferences ? (
          <Text style={[styles.noDifferencesText, { color: colors.secondaryText }]}>
            No differences - every stat matches on both sides.
          </Text>
        ) : (
          <View style={styles.compareRow}>
            <CompareColumn nft={nftA} colors={colors} traitColumns={displayedTraitColumns} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <CompareColumn nft={nftB} colors={colors} traitColumns={displayedTraitColumns} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginHorizontal: 12,
    marginVertical: 12,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  // Title and the new "Show differences only" toggle share one row -
  // title on the left, toggle on the right (space-between), same
  // horizontal margin the title used to carry on its own.
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  // Same shape as CollectionView.js's deletedSwitchGroup/
  // deletedSwitchLabel (bordered pill, label + native Switch) - kept
  // as its own local copy rather than imported since React Native
  // styles aren't shared across component files in this codebase.
  differencesSwitchGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  differencesSwitchLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  noDifferencesText: {
    fontSize: 14,
    marginTop: 24,
    textAlign: 'center',
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  compareRow: {
    flexDirection: 'row',
  },
  compareColumn: {
    flex: 1,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    marginHorizontal: 10,
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: {
    fontSize: 12,
  },
  idLine: {
    fontSize: 12,
    marginTop: 6,
  },
  nameLine: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  traitLine: {
    fontSize: 12,
    marginBottom: 4,
  },
});
