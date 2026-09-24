/**
 * WeaponSummaryRow.js
 *
 * The compact row shown for each Weapon in the main list, mirroring
 * DevikinSummaryRow.js's pattern: a picture on the left, a few key
 * identity fields stacked on the right, and the whole row is tappable to
 * open the full detail card (see NftCard.js's weapon layout, and
 * CollectionView.js for the list/detail switch that uses this).
 *
 * Rarity / Type / Quality were picked as the three fields shown here
 * because they're the closest weapon equivalent of what Devikins show in
 * their own summary row (Rarity / Ancestry / Personality) - the traits
 * that most describe "what this item fundamentally is" at a glance,
 * before you tap in to see every combat stat. This is a first pass - if
 * you'd rather see different fields here (or more of them), just say so.
 * A custom nickname, if one's been given, shows as a small pill in the
 * row's top-right corner too - see DevikinSummaryRow.js's own comment.
 */

import { useEffect, useState } from 'react';
import { Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

export default function WeaponSummaryRow({ nft, onPress, selected = false }) {
  const { colors } = useTheme();

  // Same "prefer the locally-saved copy" logic as NftCard.js/
  // DevikinSummaryRow.js - see src/api/imageStorage.js for why.
  const imageSource = nft.local_image_path || nft.image;

  // Greyed out (see styles.deletedRow) and tagged when the user has
  // marked this NFT as deleted from its detail view (see NftCard.js's
  // "Mark as Deleted" button) - still tappable to open the detail view,
  // where it can be Restored. The "Deleted" switch next to "Show
  // filters" (see CollectionView.js) is what hides these entirely,
  // rather than just greying them out here.
  const isDeleted = Boolean(nft.deleted);

  // Some items have an imageSource (a URL, or an old local path) that no
  // longer actually loads - most often an item fetched a while ago that
  // never got a local copy cached, whose original remote image host has
  // since gone offline or moved. Without this check, a broken
  // imageSource would just render as a blank box instead of the clear
  // "Unavailable" message below. onError fires whenever the Image fails
  // to load; the effect resets that flag back to false whenever
  // imageSource itself changes (e.g. once a background retry
  // successfully caches a local copy), so a since-fixed image gets a
  // fresh chance to load instead of being stuck showing the placeholder
  // forever.
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageSource]);

  const image = imageSource && !imageLoadFailed ? (
    <Image
      source={{ uri: imageSource }}
      style={styles.thumbnail}
      resizeMode="contain"
      onError={() => setImageLoadFailed(true)}
    />
  ) : (
    <View style={[styles.thumbnail, styles.thumbnailPlaceholder, { backgroundColor: colors.placeholderBackground }]}>
      <Text style={[styles.thumbnailPlaceholderText, { color: colors.placeholderText }]}>Unavailable</Text>
    </View>
  );

  // If this item's status isn't 'ok', its metadata (and therefore
  // Rarity/Type/Quality) was never successfully fetched - all three
  // would just be blank. Show one clear message instead, same wording
  // used elsewhere in the app (DevikinSummaryRow.js, NftCard.js).
  const statsAvailable = nft.status === 'ok';
  const unavailableMessage = nft.status === 'unavailable'
    ? 'Details unavailable'
    : 'Fetch failed - will retry';

  // `selected` (from CollectionView.js's own Compare mode - see its
  // file comment) draws the same colored-border highlight every other
  // "currently chosen" control in this app uses (HamburgerMenu's active
  // entry, BreedingHelper's chips) - false/absent the rest of the time,
  // so nothing changes for the normal tap-to-open-detail case.
  return (
    <TouchableOpacity
      style={[
        styles.row,
        { backgroundColor: colors.surface, shadowColor: colors.cardShadow },
        isDeleted && styles.deletedRow,
        selected && { borderWidth: 3, borderColor: colors.primary },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {image}
      {nft.custom_name ? (
        <View style={[styles.customNameBadge, { backgroundColor: colors.chipBackground, borderColor: colors.border }]}>
          <Text style={[styles.customNameBadgeText, { color: colors.primary }]} numberOfLines={1}>
            {nft.custom_name}
          </Text>
        </View>
      ) : null}
      <View style={styles.infoColumn}>
        {isDeleted && (
          <Text style={[styles.deletedTag, { color: colors.cancelText }]}>Deleted</Text>
        )}
        {/* The NFT's on-chain ID (nonce) - always shown, even when the
            metadata fetch failed and the stats below can't be, since the
            ID itself is always known. */}
        <Text style={[styles.idLine, { color: colors.secondaryText }]}>#{nft.nonce}</Text>
        {statsAvailable ? (
          <>
            <Text style={[styles.line, { color: colors.text }]}>Rarity: {nft.rarity ?? '—'}</Text>
            <Text style={[styles.line, { color: colors.text }]}>Type: {nft.type ?? '—'}</Text>
            <Text style={[styles.line, { color: colors.text }]}>Quality: {nft.quality ?? '—'}</Text>
          </>
        ) : (
          <Text style={[styles.line, { color: colors.statusText }]}>{unavailableMessage}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    marginHorizontal: 12,
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  // Greyed out when marked deleted (see isDeleted above) - opacity
  // alone rather than a different background, so it reads as "faded/
  // inactive" in both light and dark mode without needing its own
  // theme colors.
  deletedRow: {
    opacity: 0.45,
  },
  // The custom nickname (see NftCard.js's Name field), shown here too
  // so a named item is identifiable from the overview list without
  // opening it - a small pill pinned to the row's top-right corner,
  // only rendered at all when a nickname has actually been given.
  customNameBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    maxWidth: 120,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  customNameBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  deletedTag: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  idLine: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  thumbnail: {
    width: 112,
    height: 112,
    borderRadius: 12,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 6,
  },
  infoColumn: {
    marginLeft: 12,
    flex: 1,
  },
  line: {
    fontSize: 14,
    marginTop: 4,
  },
});
