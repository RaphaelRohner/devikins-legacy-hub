/**
 * StarRating.js
 *
 * A row of five tappable stars, shared by two different spots that both
 * need "pick a number 1-5" but with different meanings:
 *
 *   - The top search bar in App.js uses mode="exact": it's a FILTER, so
 *     only the star matching the current pick lights up (not every star
 *     up to it) - tapping star 3 means "show me only my 3-star items",
 *     not "3 stars or better". Per how this was designed (an exact-
 *     match filter, not a minimum-rating one).
 *   - The NFT detail view in NftCard.js uses mode="cumulative": it's an
 *     actual RATING, so the usual five-star-widget behavior applies -
 *     tapping star 3 lights up stars 1, 2, and 3 together, meaning "I'm
 *     giving this a 3-star rating".
 *
 * Either way, tapping the star that's already selected clears the pick
 * back to 0 (no filter / not rated) instead of needing a separate
 * "clear" control, and `size` lets the same component work both as a
 * small compact filter (App.js's top bar) and a larger, easier-to-tap
 * rating control (NftCard.js's detail view).
 */

import { TouchableOpacity, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

const STAR_VALUES = [1, 2, 3, 4, 5];

export default function StarRating({ value = 0, onChange, mode = 'cumulative', size = 20, disabled = false }) {
  const { colors } = useTheme();

  return (
    <View style={styles.row}>
      {STAR_VALUES.map((starValue) => {
        const isLit = mode === 'exact' ? starValue === value : starValue <= value;
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
