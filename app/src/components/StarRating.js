/**
 * StarRating.js
 *
 * A row of five tappable stars, shared by two different spots:
 *
 *   - The Filters panel (FilterPanel.js) uses it as a FILTER - picking
 *     a star still means an exact match ("show me only my 3-star
 *     items", not "3 stars or better"; see the `star_rating = ?` query
 *     in database.js). That's a filtering-logic decision made outside
 *     this component, not something `value`/`onChange` here know about.
 *   - The NFT detail view (NftCard.js) uses it as an actual RATING -
 *     tapping star 3 means "I'm giving this a 3-star rating".
 *
 * Visually, both places light up every star from 1 up to the current
 * value together (tapping star 3 lights stars 1, 2, and 3) - the usual
 * five-star-widget look, per feedback that showing only the single
 * tapped star in the Filters panel read as inconsistent with the
 * detail view. Tapping the star that's already selected clears the
 * pick back to 0 (no filter / not rated) instead of needing a separate
 * "clear" control, and `size` lets the same component work both as a
 * small compact filter (Filters panel) and a larger, easier-to-tap
 * rating control (NftCard.js's detail view).
 */

import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

const STAR_VALUES = [1, 2, 3, 4, 5];

export default function StarRating({ value = 0, onChange, size = 20, disabled = false }) {
  const { colors } = useTheme();

  return (
    <View style={styles.row}>
      {STAR_VALUES.map((starValue) => {
        const isLit = starValue <= value;
        return (
          <TouchableOpacity
            key={starValue}
            disabled={disabled}
            onPress={() => onChange?.(value === starValue ? 0 : starValue)}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          >
            <Text style={[styles.star, { fontSize: size, color: isLit ? colors.primary : colors.secondaryText }]}>
              ★
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 2,
  },
  star: {
    fontWeight: '400',
  },
});
