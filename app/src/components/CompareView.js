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
 * Every stat is shown, not a hand-picked subset, per Raphael's own call
 * on this - may well grow into something more curated later once this
 * has been used for a while.
 */

import { Image, ScrollView, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
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

  // Every trait this kind has that's meant to be user-facing - the same
  // `filterable !== false` rule NftCard.js's own full detail view and
  // getSortableFieldNames (schema.js) already use, so this list matches
  // what you'd see if you tapped into either NFT's own detail view,
  // just both sides at once. Rarity's included here too, same as every
  // other trait - no special-casing needed.
  const traitColumns = Object.keys(TRAIT_COLUMNS[kind]).filter(
    (columnName) => TRAIT_COLUMNS[kind][columnName].filterable !== false
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[styles.title, { color: colors.text }]}>Compare</Text>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.compareRow}>
          <CompareColumn nft={nftA} colors={colors} traitColumns={traitColumns} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <CompareColumn nft={nftB} colors={colors} traitColumns={traitColumns} />
        </View>
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
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginHorizontal: 12,
    marginBottom: 8,
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
