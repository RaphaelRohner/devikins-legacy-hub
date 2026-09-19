/**
 * NftTile.js
 *
 * The compact square tile shown for each NFT when a collection screen
 * is switched to "Tiles" view (see the list/tiles toggle in
 * CollectionView.js) - a dense grid of just the picture and its ID,
 * instead of the full-width picture-plus-a-few-traits row the summary
 * row components (DevikinSummaryRow.js etc.) show in "List" view. Tiles
 * are meant for quickly scanning a large collection by picture; tap one
 * to open the same full detail view either view eventually leads to.
 *
 * Deliberately as minimal as the summary rows, per the same "don't
 * repeat what you'd need to tap in to see anyway" reasoning - just the
 * image and the ID, so more items fit on screen at once, which is the
 * whole point of a tiles/grid view over a list.
 */

import { useEffect, useState } from 'react';
import { Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

export default function NftTile({ nft, onPress }) {
  const { colors } = useTheme();

  // Same "prefer the locally-saved copy" logic as the summary rows and
  // NftCard.js - see src/api/imageStorage.js for why.
  const imageSource = nft.local_image_path || nft.image;
  const isDeleted = Boolean(nft.deleted);

  // Same broken-image handling as the summary rows - see their own
  // comments for the full reasoning (an old cached URL whose host has
  // since gone offline shouldn't just render a blank box).
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

  return (
    <TouchableOpacity
      style={[styles.tile, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }, isDeleted && styles.deletedTile]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {image}
      {isDeleted && (
        <Text style={[styles.deletedTag, { color: colors.cancelText }]}>Deleted</Text>
      )}
      <Text style={[styles.idText, { color: colors.secondaryText }]}>#{nft.nonce}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexBasis: '31%',
    borderRadius: 10,
    padding: 8,
    marginBottom: 12,
    alignItems: 'center',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  deletedTile: {
    opacity: 0.45,
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 4,
  },
  deletedTag: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 6,
  },
  idText: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 6,
  },
});
