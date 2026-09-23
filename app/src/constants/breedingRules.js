/**
 * breedingRules.js
 *
 * A small, dedicated home for the breeding-specific game mechanics that
 * BreedingHelper.js needs but that don't belong in schema.js (schema.js
 * is about what a Devikin's DATA looks like, not the game's breeding
 * economy). Everything here comes from Raphael's own breeding
 * experience (roughly 2,000 procreations done) - there's no official
 * documentation of any of it. See BreedingHelper.js's own file comment
 * for the full research trail and the rest of the pairing rules.
 *
 * The cost to breed a Devikin doubles for every procreation it's
 * already used, starting from a base amount set by its Rarity at a
 * full 10 Procreations Left (a Devikin that's never bred). Eldritch
 * has no base cost here since it can never breed at all - see
 * RARITY_ORDER's own comment in schema.js.
 */
export const BREEDING_BASE_COST_BY_RARITY = {
  Common: 300,
  Uncommon: 400,
  Rare: 500,
  Mythic: 600,
};

// The most Procreations Left a Devikin can ever have (brand new, never
// bred) - the point BREEDING_BASE_COST_BY_RARITY's base amount applies
// to, before any doubling.
export const MAX_PROCREATIONS_LEFT = 10;

/**
 * Estimates the cost to breed a Devikin of the given Rarity, currently
 * at `procreationsLeft`. Doubles for every procreation already used
 * relative to a fresh (10 left) Devikin of the same Rarity - see this
 * file's own comment above.
 *
 * When the two Devikins being paired don't share the same Procreations
 * Left (only possible when Breeding Helper's "Allow +/-1" toggle is on
 * - see BreedingHelper.js), the game charges based on whichever of the
 * two has FEWER Procreations Left, not the higher one - callers should
 * pass that lower value in as `procreationsLeft`, not either parent's
 * own value blindly.
 *
 * Returns null (rather than a wrong number) if `rarity` isn't a known
 * breedable tier (Eldritch, or anything not in
 * BREEDING_BASE_COST_BY_RARITY) or `procreationsLeft` is outside the
 * valid 1-10 range.
 */
export function estimateBreedingCost(rarity, procreationsLeft) {
  const baseCost = BREEDING_BASE_COST_BY_RARITY[rarity];
  if (baseCost === undefined) return null;
  const left = Number(procreationsLeft);
  if (!Number.isFinite(left) || left < 1 || left > MAX_PROCREATIONS_LEFT) return null;
  const timesAlreadyUsed = MAX_PROCREATIONS_LEFT - left;
  return baseCost * Math.pow(2, timesAlreadyUsed);
}
