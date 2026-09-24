/**
 * BreedingHelper.js
 *
 * A guided, two-step screen for finding a good breeding partner among
 * your own Devikins. This is App.js's eighth "screen" (see App.js's own
 * file comment for the pattern - `currentScreen === 'breeding'`), opened
 * from the hamburger menu, with the same full-screen-takeover shape and
 * small round "‹" back button every other menu screen uses (Wallets/
 * Feedback/Devi).
 *
 * WHY THIS EXISTS AND WHAT IT CAN'T DO: there's no official documentation
 * of Devikins breeding strategy - the game's own guide pages cover
 * eligibility (not immediate relatives, max 10 procreations per Devikin,
 * Eldritch can't breed at all - it's one of the breeding *goals*, kept
 * rare on purpose) and the mechanical bits (incubator type controls the
 * offspring's Rarity cap; genes "blend" with a small mutation chance;
 * Ancestry comes from "one of the parents") but nothing about which
 * PAIRINGS are actually worth attempting. That part comes entirely from
 * Raphael's own breeding experience (roughly 2,000 procreations done):
 *
 *   1. Always breed the exact same Rarity - anything else is a waste.
 *      No exception to this one, ever.
 *   2. Always breed the exact same Procreations Left - anything else
 *      is a waste. There IS a real, sometimes-necessary exception here
 *      though: a mismatched pair (say 10 left with 6 left) still
 *      breeds fine in-game, it's just priced off whichever parent has
 *      FEWER Procreations Left, and the offspring's own Procreations
 *      Left is (that lower number) - 1. The "Allow +/-1 Procreations
 *      Left" toggle below widens Step 2's matches to include partners
 *      one off from the selected Devikin's own count, for exactly
 *      those times - it's opt-in and off by default, since an exact
 *      match is still the better outcome whenever one's available.
 *   3. Genes are basically random - there's no way to steer them, so
 *      this screen doesn't try to filter or score by them.
 *   4. To raise your odds of specific Affinities in the offspring, pair
 *      two Devikins that are BOTH strong in the same Affinity (1-10, 10
 *      is best) - and this can be done for up to two Affinities at
 *      once, since the real case is breeding for a specific pair
 *      together (Agility for turn order, Power for damage, say - see
 *      the "Target Affinities" control below, capped at two).
 *   5. The breeding cost is exponential: it starts from a base amount
 *      set by Rarity (Common 300, Uncommon 400, Rare 500, Mythic 600 -
 *      all at a full 10 Procreations Left) and doubles for every
 *      procreation already used - see src/constants/breedingRules.js
 *      for the actual numbers and estimateBreedingCost, which Step 2
 *      uses to show each candidate's estimated cost and the resulting
 *      offspring's Procreations Left.
 *
 * THE ONE THING THIS SCREEN CANNOT DO, EVER: tell you whether two
 * Devikins are actually related (parent, sibling, offspring). No
 * lineage/parent data exists anywhere in this app's metadata source -
 * confirmed against every known trait in src/constants/schema.js. That
 * check is still entirely on you, exactly like it is in the game
 * itself today (this is called out on-screen, prominently, in Step 2 -
 * see the disclaimer banner below). If the game or its records ever
 * become more open about this, this screen is exactly where that data
 * would plug in.
 *
 * THE FLOW ITSELF, matching what was asked for almost exactly ("pick
 * say common, 8 procreations left, ancestry xyz, and values for the
 * affinities. You get a list and select one then you get a list on the
 * other side of the screen matching."):
 *
 *   STEP 1 - a small, purpose-built filter panel (Rarity, Ancestry,
 *   Procreations Left, and a collapsible Affinities section) narrows
 *   down YOUR OWN Devikins to a pickable list. This is deliberately a
 *   separate, simpler set of controls from FilterPanel.js/
 *   CollectionView.js's own filters - it only ever shows breeding-
 *   relevant columns, filters immediately as you type/pick (no Apply
 *   button - there's no "several changes at once" reason to hold these
 *   back the way the main list's filters do), and Eldritch is never
 *   offered as a Rarity choice since it can't breed. Tapping a result
 *   selects it as your starting Devikin. A "Reset all Step 1 fields"
 *   button sits right under this screen's own top explanation,
 *   visible only while Step 1 is showing, to clear every one of these
 *   fields - including the Target Affinities picker and the Allow
 *   +/-1 toggle below, since both start out as Step 1 picks too - back
 *   to their defaults in one tap.
 *
 *   STEP 2 - once a starting Devikin is selected, a second list shows
 *   every OTHER Devikin in your collection that shares its exact
 *   Rarity, and (by default) its exact Procreations Left too - or a
 *   Procreations Left one off from it either way, if "Allow +/-1" is
 *   toggled on (see rule 2 above and getBreedingCandidates in
 *   src/db/database.js for the actual query and the full eligibility
 *   rules). Matches are sorted with the closest Procreations Left match
 *   first (exact matches before +/-1 ones), then - if one or two Target
 *   Affinities were chosen back in Step 1 - by whichever of those is
 *   WEAKER for that candidate, strongest-first (so a candidate has to
 *   be strong in all of them, not just one, to rank well).
 *   Tapping a match expands a quick side-by-side Affinity comparison
 *   against your selected Devikin, right in place, including the
 *   estimated cost and the offspring's resulting Procreations Left -
 *   just enough to sanity-check a pairing without leaving this screen.
 *   "‹ Step 1" returns to Step 1 without losing your filter picks.
 *
 * This intentionally does NOT build the separate "Compare two NFTs"
 * screen that was asked for alongside this one - that's its own,
 * differently-scoped feature (general-purpose comparison, not specific
 * to breeding) and gets its own design pass.
 */

import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Image, Switch, StyleSheet } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useTheme } from '../context/ThemeContext';
import { queryNfts, getDistinctColumnValues, getColumnRange, getBreedingCandidates } from '../db/database';
import { RARITY_ORDER } from '../constants/schema';
import { estimateBreedingCost } from '../constants/breedingRules';
import { NO_FILTER } from './FilterPanel';

// Five of Devikins' six Affinity columns (see schema.js's
// TRAIT_COLUMNS.devikin) - every stat EXCEPT Overall Affinity, which
// this screen leaves out entirely (filters, Target Affinities, and the
// Step 2 comparison alike) per feedback: Overall is just a summary of
// these other five, not an independent stat you can filter for or pair
// to steer, so it isn't something a breeding decision can act on.
// Procreations Left and Rarity get their own dedicated controls below
// since they're hard eligibility rules (see the file comment above),
// not a soft preference like these five are.
const AFFINITY_COLUMNS = [
  'vitality_affinity',
  'power_affinity',
  'fortitude_affinity',
  'agility_affinity',
  'sanity_affinity',
];

const AFFINITY_LABELS = {
  vitality_affinity: 'Vitality',
  power_affinity: 'Power',
  fortitude_affinity: 'Fortitude',
  agility_affinity: 'Agility',
  sanity_affinity: 'Sanity',
};

export default function BreedingHelper({ ownerAddresses, onClose }) {
  const { colors } = useTheme();

  // ---- Step 1: filter options and picks ----
  // availableOptions is derived from what's actually in the user's own
  // Devikins, same reasoning as CollectionView.js's own availableOptions
  // - no point offering an Ancestry nobody's collection has. Loaded once
  // up front rather than re-derived on every filter change, since the
  // set of POSSIBLE values doesn't change just because a filter narrowed
  // the results.
  const [availableOptions, setAvailableOptions] = useState({});
  const [rarityFilter, setRarityFilter] = useState(NO_FILTER);
  const [ancestryFilter, setAncestryFilter] = useState(NO_FILTER);
  const [procreationsMin, setProcreationsMin] = useState('');
  const [procreationsMax, setProcreationsMax] = useState('');
  const [affinityRanges, setAffinityRanges] = useState({});
  const [affinitiesExpanded, setAffinitiesExpanded] = useState(false);
  // Which Affinities (zero, one, or two) Step 2's matches get sorted
  // by - a Step 1 pick since it's part of "what am I looking for", but
  // it only ever affects Step 2's ordering (see the loadMatches effect
  // below). Capped at two per feedback: the real use case is breeding
  // for a specific pair of stats together (Agility for turn order,
  // Power for damage, say), and a candidate has to be strong in BOTH
  // chosen Affinities to rank well - see loadMatches' own comment for
  // exactly how that's scored. handleToggleTargetAffinity below is what
  // enforces the cap by dropping the oldest pick once a third is tapped.
  const [targetAffinities, setTargetAffinities] = useState([]);
  // Off by default - Step 2 only shows partners at the selected
  // Devikin's EXACT Procreations Left. Switching this on widens that
  // to +/-1 either way, for the real (if less ideal) cases where an
  // exact match just isn't available yet - see rule 2 in the file
  // comment above for what a mismatched pair actually costs/produces,
  // which MatchRow surfaces per-candidate once this is on.
  const [allowProcreationsTolerance, setAllowProcreationsTolerance] = useState(false);

  const [pickList, setPickList] = useState([]);
  const [pickListLoading, setPickListLoading] = useState(true);

  // ---- Step 2: the selected starting Devikin and its matches ----
  const [selected, setSelected] = useState(null);
  const [matches, setMatches] = useState([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [expandedMatchNonce, setExpandedMatchNonce] = useState(null);

  // Loads the filter dropdown/range options once, from the user's own
  // Devikins - same getDistinctColumnValues/getColumnRange functions
  // CollectionView.js's own availableOptions effect uses, just scoped to
  // exactly the columns this screen cares about instead of every
  // filterable trait. Rarity deliberately drops Eldritch from the list
  // of choices entirely (see the file comment above) and is put in
  // breeding-ladder order the same way CollectionView.js orders it,
  // rather than the database's default alphabetical order.
  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      const options = {};

      const rarityValues = await getDistinctColumnValues('devikin', 'rarity', ownerAddresses);
      const breedableRarities = rarityValues
        .filter((value) => value !== 'Eldritch')
        .sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
      if (breedableRarities.length > 0) {
        options.rarity = { kind: 'text', values: breedableRarities };
      }

      const ancestryValues = await getDistinctColumnValues('devikin', 'ancestry', ownerAddresses);
      if (ancestryValues.length > 0) {
        options.ancestry = { kind: 'text', values: ancestryValues };
      }

      const procreationsRange = await getColumnRange('devikin', 'procreations_left', ownerAddresses);
      if (procreationsRange.min !== null) {
        options.procreations_left = { kind: 'integer', ...procreationsRange };
      }

      for (const columnName of AFFINITY_COLUMNS) {
        const range = await getColumnRange('devikin', columnName, ownerAddresses);
        if (range.min !== null) {
          options[columnName] = { kind: 'integer', ...range };
        }
      }

      if (!cancelled) {
        setAvailableOptions(options);
      }
    }

    loadOptions();
    return () => {
      cancelled = true;
    };
  }, [ownerAddresses]);

  // Re-runs the Step 1 query on every filter change - no separate Apply
  // button here, unlike CollectionView.js's own Filters panel. That
  // panel needs Apply because it's a large flat/grouped list where you
  // typically set several picks together before they should take effect
  // (see CollectionView.js's own file comment for the full reasoning).
  // This screen's filter set is small and single-purpose (narrow down
  // to ONE starting Devikin), so there's nothing lost by having each
  // change reflect immediately - it reads more like a live search than
  // a big filter form.
  useEffect(() => {
    if (selected) return; // Step 2 has taken over - no need to keep querying in the background
    let cancelled = false;

    async function loadPickList() {
      setPickListLoading(true);
      const filters = {};
      if (rarityFilter !== NO_FILTER) filters.rarity = rarityFilter;
      if (ancestryFilter !== NO_FILTER) filters.ancestry = ancestryFilter;
      if (procreationsMin !== '' || procreationsMax !== '') {
        filters.procreations_left = { min: procreationsMin, max: procreationsMax };
      }
      for (const columnName of AFFINITY_COLUMNS) {
        const range = affinityRanges[columnName];
        if (range && (range.min !== undefined && range.min !== '' || range.max !== undefined && range.max !== '')) {
          filters[columnName] = range;
        }
      }

      const rows = await queryNfts('devikin', ownerAddresses, filters, true, '', null, 'nonce', 'asc');
      // Baseline breeding eligibility, enforced regardless of what the
      // user picked above - matches getBreedingCandidates' own rules in
      // database.js, so a Devikin that shows up here is always actually
      // pickable as a starting point, never a dead end once you reach
      // Step 2.
      const eligible = rows.filter(
        (row) => row.status === 'ok' && row.rarity !== 'Eldritch' && Number(row.procreations_left) > 0
      );

      if (!cancelled) {
        setPickList(eligible);
        setPickListLoading(false);
      }
    }

    loadPickList();
    return () => {
      cancelled = true;
    };
  }, [selected, rarityFilter, ancestryFilter, procreationsMin, procreationsMax, affinityRanges, ownerAddresses]);

  // Once a starting Devikin is selected, loads its matching partners -
  // see getBreedingCandidates' own comment in database.js for exactly
  // what "matching" means (same Rarity, same Procreations Left by
  // default, or +/-1 if allowProcreationsTolerance is on - both
  // eligible). Sorted with the closest Procreations Left match first
  // (an exact match always beats a +/-1 one, per rule 2 in the file
  // comment above - a mismatched pair is only ever a fallback, not an
  // equal alternative), then - if one or two Target Affinities were
  // picked in Step 1 - by whichever of those chosen Affinities is
  // WEAKER for that candidate, strongest-first. Using the weaker of the
  // two (rather than their sum or average) is deliberate: a candidate
  // with, say, Agility 10 / Power 9 should rank above one with Agility
  // 10 / Power 3, since the whole point is a candidate that's strong in
  // BOTH chosen stats together (per feedback - the real case is
  // breeding for Agility, which decides turn order, and Power, for
  // damage, at the same time) - a sum or average could let one very
  // high stat mask a genuinely weak one. This is a secondary, soft
  // ordering preference on top of the Procreations Left match, not a
  // filter - a candidate weak in the chosen Affinities still shows, just
  // further down.
  useEffect(() => {
    if (!selected) {
      setMatches([]);
      return;
    }
    let cancelled = false;

    async function loadMatches() {
      setMatchesLoading(true);
      const rows = await getBreedingCandidates(ownerAddresses, {
        rarity: selected.rarity,
        procreationsLeft: selected.procreations_left,
        excludeNonce: selected.nonce,
        procreationsTolerance: allowProcreationsTolerance ? 1 : 0,
      });

      const selectedProcreationsLeft = Number(selected.procreations_left);
      const sorted = [...rows].sort((a, b) => {
        const diffA = Math.abs(Number(a.procreations_left) - selectedProcreationsLeft);
        const diffB = Math.abs(Number(b.procreations_left) - selectedProcreationsLeft);
        if (diffA !== diffB) return diffA - diffB;
        if (targetAffinities.length > 0) {
          const weakestA = Math.min(...targetAffinities.map((columnName) => Number(a[columnName]) || 0));
          const weakestB = Math.min(...targetAffinities.map((columnName) => Number(b[columnName]) || 0));
          if (weakestA !== weakestB) return weakestB - weakestA;
        }
        return 0; // Array.prototype.sort is stable - falls back to the nonce ASC order the SQL query already returned
      });

      if (!cancelled) {
        setMatches(sorted);
        setMatchesLoading(false);
      }
    }

    loadMatches();
    return () => {
      cancelled = true;
    };
  }, [selected, targetAffinities, allowProcreationsTolerance, ownerAddresses]);

  function handleAffinityRangeChange(columnName, key, text) {
    setAffinityRanges((previous) => ({
      ...previous,
      [columnName]: { ...previous[columnName], [key]: text },
    }));
  }

  // Toggles one Affinity chip on/off in the Target Affinities picker -
  // tapping an already-selected one deselects it; tapping a new one
  // adds it, UNLESS two are already chosen, in which case the oldest
  // pick is dropped to make room (so tapping a third chip always does
  // something visible, rather than silently refusing it).
  function handleToggleTargetAffinity(columnName) {
    setTargetAffinities((previous) => {
      if (previous.includes(columnName)) {
        return previous.filter((existing) => existing !== columnName);
      }
      if (previous.length >= 2) {
        return [...previous.slice(1), columnName];
      }
      return [...previous, columnName];
    });
  }

  // Clears every Step 1 field back to its default - the plain filters,
  // the collapsible Affinities ranges, the Target Affinities picker,
  // and the Allow +/-1 toggle - in one tap, rather than clearing each
  // one by hand. Only ever shown in Step 1 itself (see the reset
  // button's render below); Step 2's own state (the selected starting
  // Devikin, its matches) is untouched, so resetting filters doesn't
  // knock you back to Step 1's list if you weren't already there.
  function handleResetFilters() {
    setRarityFilter(NO_FILTER);
    setAncestryFilter(NO_FILTER);
    setProcreationsMin('');
    setProcreationsMax('');
    setAffinityRanges({});
    setAffinitiesExpanded(false);
    setTargetAffinities([]);
    setAllowProcreationsTolerance(false);
  }

  function handleSelectStarter(nft) {
    setSelected(nft);
    setExpandedMatchNonce(null);
  }

  function handleChangeSelection() {
    setSelected(null);
    setExpandedMatchNonce(null);
  }

  // Shared between Step 1's filter panel and Step 2's header (see the
  // listHeader definitions below) - toggling this re-queries Step 2's
  // matches immediately (it's a dependency of the loadMatches effect
  // above) even when it's changed from inside Step 2 itself, so a user
  // who hits "0 eligible partners found" can turn it on right there
  // without going back to Step 1 first.
  const toleranceToggleRow = (
    <View style={[styles.filterRow, styles.toggleRow]}>
      <View style={styles.toggleTextColumn}>
        <Text style={[styles.filterLabel, { color: colors.text }]}>Allow +/-1 Procreations Left</Text>
        <Text style={[styles.filterHint, { color: colors.secondaryText }]}>
          Off by default (rule 2: matching Procreations Left is the better outcome). Turning this on also shows
          partners one Procreations Left off from your selected Devikin, for when an exact match isn't available -
          the game charges based on whichever of the two is lower, and the offspring's Procreations Left is that
          lower number minus one, both shown per-candidate below once this is on.
        </Text>
      </View>
      <Switch
        value={allowProcreationsTolerance}
        onValueChange={setAllowProcreationsTolerance}
        trackColor={{ true: colors.primary }}
      />
    </View>
  );

  // ---- Step 1: the filter controls, rendered as the list's header ----
  const filterControls = (
    <View style={styles.filterBlock}>
      <View style={styles.filterRow}>
        <Text style={[styles.filterLabel, { color: colors.text }]}>Rarity</Text>
        <View style={[styles.pickerWrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Picker
            selectedValue={rarityFilter}
            onValueChange={setRarityFilter}
            style={{ color: colors.text }}
            dropdownIconColor={colors.text}
          >
            <Picker.Item label="All (breedable rarities)" value={NO_FILTER} />
            {(availableOptions.rarity?.values ?? []).map((value) => (
              <Picker.Item key={value} label={value} value={value} />
            ))}
          </Picker>
        </View>
      </View>

      {availableOptions.ancestry && (
        <View style={styles.filterRow}>
          <Text style={[styles.filterLabel, { color: colors.text }]}>Ancestry</Text>
          <View style={[styles.pickerWrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Picker
              selectedValue={ancestryFilter}
              onValueChange={setAncestryFilter}
              style={{ color: colors.text }}
              dropdownIconColor={colors.text}
            >
              <Picker.Item label="All" value={NO_FILTER} />
              {availableOptions.ancestry.values.map((value) => (
                <Picker.Item key={value} label={String(value)} value={value} />
              ))}
            </Picker>
          </View>
        </View>
      )}

      {availableOptions.procreations_left && (
        <View style={styles.filterRow}>
          <Text style={[styles.filterLabel, { color: colors.text }]}>
            Procreations Left (found: {availableOptions.procreations_left.min} to {availableOptions.procreations_left.max})
          </Text>
          <View style={styles.rangeRow}>
            <TextInput
              style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              placeholder="min"
              placeholderTextColor={colors.secondaryText}
              value={procreationsMin}
              onChangeText={setProcreationsMin}
            />
            <Text style={[styles.rangeSeparator, { color: colors.secondaryText }]}>to</Text>
            <TextInput
              style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              placeholder="max"
              placeholderTextColor={colors.secondaryText}
              value={procreationsMax}
              onChangeText={setProcreationsMax}
            />
          </View>
        </View>
      )}

      {toleranceToggleRow}

      <TouchableOpacity onPress={() => setAffinitiesExpanded((current) => !current)} style={styles.groupHeaderButton}>
        <Text style={[styles.groupHeaderText, { color: colors.primary }]}>
          Affinities {affinitiesExpanded ? '▲' : '▼'}
        </Text>
      </TouchableOpacity>
      {affinitiesExpanded && AFFINITY_COLUMNS.map((columnName) => {
        const option = availableOptions[columnName];
        if (!option) return null;
        return (
          <View key={columnName} style={styles.filterRow}>
            <Text style={[styles.filterLabel, { color: colors.text }]}>
              {AFFINITY_LABELS[columnName]} Affinity (found: {option.min} to {option.max})
            </Text>
            <View style={styles.rangeRow}>
              <TextInput
                style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                placeholder="min"
                placeholderTextColor={colors.secondaryText}
                value={affinityRanges[columnName]?.min ?? ''}
                onChangeText={(text) => handleAffinityRangeChange(columnName, 'min', text)}
              />
              <Text style={[styles.rangeSeparator, { color: colors.secondaryText }]}>to</Text>
              <TextInput
                style={[styles.rangeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                placeholder="max"
                placeholderTextColor={colors.secondaryText}
                value={affinityRanges[columnName]?.max ?? ''}
                onChangeText={(text) => handleAffinityRangeChange(columnName, 'max', text)}
              />
            </View>
          </View>
        );
      })}

      <View style={styles.filterRow}>
        <Text style={[styles.filterLabel, { color: colors.text }]}>Target Affinities for matching (optional, up to 2)</Text>
        <View style={styles.affinityChipRow}>
          {AFFINITY_COLUMNS.map((columnName) => {
            const isSelected = targetAffinities.includes(columnName);
            return (
              <TouchableOpacity
                key={columnName}
                style={[
                  styles.affinityChip,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  isSelected && { borderColor: colors.primary, backgroundColor: colors.chipBackground },
                ]}
                onPress={() => handleToggleTargetAffinity(columnName)}
              >
                <Text style={[styles.affinityChipText, { color: isSelected ? colors.primary : colors.secondaryText }]}>
                  {AFFINITY_LABELS[columnName]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={[styles.filterHint, { color: colors.secondaryText }]}>
          Sorts Step 2's partner list so candidates strong in ALL of your chosen Affinities show up first - not just
          the sum of them, so one high stat can't cover for a weak one. Pick up to two (say Agility for turn order
          and Power for damage) - tapping a third swaps out whichever you picked first. Pairing two Devikins that
          are both strong in the same Affinities raises your odds - it's never guaranteed.
        </Text>
      </View>
    </View>
  );

  const listHeader = selected ? (
    <View style={styles.stepHeader}>
      <Text style={[styles.stepLabel, { color: colors.secondaryText }]}>STEP 2 OF 2 · Matching partners</Text>

      <View style={[styles.selectedCard, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Thumbnail nft={selected} colors={colors} />
        <View style={styles.selectedInfoColumn}>
          <Text style={[styles.selectedIdLine, { color: colors.secondaryText }]}>
            #{selected.nonce}{selected.custom_name ? ` · ${selected.custom_name}` : ''}
          </Text>
          <Text style={[styles.selectedLine, { color: colors.text }]}>Rarity: {selected.rarity}</Text>
          <Text style={[styles.selectedLine, { color: colors.text }]}>Procreations Left: {selected.procreations_left}</Text>
          <Text style={[styles.selectedLine, { color: colors.text }]}>Ancestry: {selected.ancestry ?? '—'}</Text>
        </View>
        <TouchableOpacity
          style={[styles.changeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={handleChangeSelection}
        >
          <Text style={[styles.changeButtonText, { color: colors.cancelText }]}>‹ Step 1</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.disclaimerBanner, { backgroundColor: colors.statusFailedBackground, borderColor: colors.border }]}>
        <Text style={[styles.disclaimerText, { color: colors.text }]}>
          This app can't tell whether two Devikins are related (parent, sibling, or offspring) - there's no lineage
          data available anywhere. Please double-check relatedness yourself before breeding, the same as you would
          in the game itself.
        </Text>
      </View>

      {toleranceToggleRow}

      <Text style={[styles.resultsCountLine, { color: colors.secondaryText }]}>
        {matchesLoading
          ? 'Loading matches...'
          : `${matches.length} eligible partner${matches.length === 1 ? '' : 's'} found (same Rarity${allowProcreationsTolerance ? ', Procreations Left within 1' : ', same Procreations Left'})`}
      </Text>
    </View>
  ) : (
    <View style={styles.stepHeader}>
      <Text style={[styles.stepLabel, { color: colors.secondaryText }]}>STEP 1 OF 2 · Pick a starting Devikin</Text>
      {filterControls}
      <Text style={[styles.resultsCountLine, { color: colors.secondaryText }]}>
        {pickListLoading ? 'Loading...' : `${pickList.length} breedable Devikin${pickList.length === 1 ? '' : 's'} match`}
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Breeding Helper</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        Pick one of your Devikins, then see which others in your collection are actually worth pairing with it.
      </Text>

      {!selected && (
        <TouchableOpacity style={[styles.resetFiltersButton, { borderColor: colors.border }]} onPress={handleResetFilters}>
          <Text style={[styles.resetFiltersButtonText, { color: colors.primary }]}>Reset all Step 1 fields</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={selected ? matches : pickList}
        keyExtractor={(item) => String(item.nonce)}
        ListHeaderComponent={listHeader}
        renderItem={({ item }) =>
          selected ? (
            <MatchRow
              nft={item}
              compareWith={selected}
              targetAffinities={targetAffinities}
              expanded={expandedMatchNonce === item.nonce}
              onToggleExpand={() => setExpandedMatchNonce((current) => (current === item.nonce ? null : item.nonce))}
              colors={colors}
            />
          ) : (
            <PickRow nft={item} onPress={() => handleSelectStarter(item)} colors={colors} />
          )
        }
        ListEmptyComponent={
          !pickListLoading && !matchesLoading ? (
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              {selected
                ? "No eligible partners found in your collection right now. Try a different starting Devikin, or breed later once you've got another one at the same Rarity and Procreations Left."
                : 'No Devikins match these filters yet.'}
            </Text>
          ) : null
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

// The thumbnail image, shared by the selected-Devikin summary card and
// both row components below - same "prefer the locally-saved copy, fall
// back to an 'Unavailable' placeholder box rather than a blank one" logic
// DevikinSummaryRow.js already uses elsewhere in the app, just without
// its own onError/imageLoadFailed state (a rare edge case - a broken
// image here just falls back to React Native's own default broken-image
// behavior rather than the labeled placeholder - not worth duplicating
// that whole state machine three times over for something this minor).
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

// Step 1's row - deliberately shows Procreations Left alongside Rarity/
// Ancestry (DevikinSummaryRow.js's own row shows Personality instead,
// which doesn't matter for breeding) since it's one of the two hard
// eligibility rules this whole screen is built around.
function PickRow({ nft, onPress, colors }) {
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Thumbnail nft={nft} colors={colors} />
      <View style={styles.infoColumn}>
        <Text style={[styles.idLine, { color: colors.secondaryText }]}>
          #{nft.nonce}{nft.custom_name ? ` · ${nft.custom_name}` : ''}
        </Text>
        <Text style={[styles.line, { color: colors.text }]}>Rarity: {nft.rarity ?? '—'}</Text>
        <Text style={[styles.line, { color: colors.text }]}>Procreations Left: {nft.procreations_left ?? '—'}</Text>
        <Text style={[styles.line, { color: colors.text }]}>Ancestry: {nft.ancestry ?? '—'}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Step 2's row - Rarity is always identical to the selected Devikin
// (that's the whole point of getBreedingCandidates' filter), so it's
// left off here to avoid repeating it on every single row; Procreations
// Left is now shown (it can differ from the selected Devikin's own when
// the "Allow +/-1" toggle is on - see BreedingHelper.js's own file
// comment for rule 2) with a note when it does, plus the estimated cost
// and the offspring's resulting Procreations Left - both computed off
// whichever of the two parents has FEWER Procreations Left, per how the
// game actually prices a mismatched pair (see estimateBreedingCost's own
// comment in src/constants/breedingRules.js). Ancestry is shown too
// since it can differ. Whichever Target Affinities were chosen (if any,
// up to two) each get their own highlighted line so the sort order this
// list is already in is visible at a glance, not just implied.
//
// Tapping a row expands a quick Affinity comparison against the
// selected Devikin, right in place, as a full-width strip BELOW the
// thumbnail+info line (not nested inside either column) - two side-by-
// side halves, selected Devikin on the left and this candidate on the
// right, that start at the exact same height since they're siblings in
// the same row rather than each being tucked under a column of
// different height. Two earlier attempts got this wrong: nesting both
// halves inside the (already thumbnail-narrowed) info column alone
// left too little width for "this candidate"'s header to fit on one
// line; and splitting them one-under-the-thumbnail/one-under-the-info
// instead just moved the misalignment rather than fixing it, since the
// info column has several lines of its own above the comparison and
// the thumbnail doesn't - confirmed by Raphael happening the same way
// even when the thumbnail image loads fine, so it was never actually
// about the image.
function MatchRow({ nft, compareWith, targetAffinities, expanded, onToggleExpand, colors }) {
  const candidateProcreationsLeft = Number(nft.procreations_left);
  const selectedProcreationsLeft = Number(compareWith.procreations_left);
  const proceationsMismatch = candidateProcreationsLeft !== selectedProcreationsLeft;
  const lowerProcreationsLeft = Math.min(candidateProcreationsLeft, selectedProcreationsLeft);
  const estimatedCost = estimateBreedingCost(nft.rarity, lowerProcreationsLeft);
  const offspringProcreationsLeft = lowerProcreationsLeft - 1;

  return (
    <TouchableOpacity
      style={[styles.row, styles.matchRow, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}
      onPress={onToggleExpand}
      activeOpacity={0.7}
    >
      <View style={styles.rowMainContent}>
        <Thumbnail nft={nft} colors={colors} />
        <View style={styles.infoColumn}>
          <Text style={[styles.idLine, { color: colors.secondaryText }]}>
            #{nft.nonce}{nft.custom_name ? ` · ${nft.custom_name}` : ''}
          </Text>
          <Text style={[styles.line, { color: colors.text }]}>
            Procreations Left: {nft.procreations_left}
            {proceationsMismatch ? ` (yours is ${compareWith.procreations_left} - breeding uses the lower count)` : ''}
          </Text>
          <Text style={[styles.line, { color: colors.text }]}>Ancestry: {nft.ancestry ?? '—'}</Text>
          {targetAffinities.map((columnName) => (
            <Text key={columnName} style={[styles.line, styles.highlightedLine, { color: colors.primary }]}>
              {AFFINITY_LABELS[columnName]} Affinity: {nft[columnName] ?? '—'}
            </Text>
          ))}
          {estimatedCost !== null && (
            <Text style={[styles.line, { color: colors.secondaryText }]}>
              Est. cost: {estimatedCost.toLocaleString()} · offspring gets {offspringProcreationsLeft} Procreations Left
            </Text>
          )}
          <Text style={[styles.tapHint, { color: colors.secondaryText }]}>
            {expanded ? 'Tap to hide comparison' : 'Tap to compare Affinities'}
          </Text>
        </View>
      </View>

      {expanded && (
        <View style={[styles.compareBlock, { borderTopColor: colors.border }]}>
          {/* Selected stays on the left (per feedback - that part was
              already right) and this candidate on the right, but now
              the two columns are sized to match rowMainContent's own
              split (thumbnail width on the left, then infoColumn's
              marginLeft on the right) instead of an even 50/50 - so
              "this candidate"'s Affinity lines land at the exact same
              left edge as "Procreations Left"/"Ancestry" directly
              above them, reading as one continuous column about the
              candidate, rather than two arbitrarily-even halves. */}
          <View style={styles.compareColumnLeft}>
            <Text style={[styles.compareHeader, { color: colors.secondaryText }]}>#{compareWith.nonce} (selected)</Text>
            {AFFINITY_COLUMNS.map((columnName) => (
              <Text key={columnName} style={[styles.compareLine, { color: colors.text }]}>
                {AFFINITY_LABELS[columnName]}: {compareWith[columnName] ?? '—'}
              </Text>
            ))}
          </View>
          <View style={styles.compareColumnRight}>
            <Text style={[styles.compareHeader, { color: colors.secondaryText }]}>#{nft.nonce} (this candidate)</Text>
            {AFFINITY_COLUMNS.map((columnName) => (
              <Text key={columnName} style={[styles.compareLine, { color: colors.text }]}>
                {AFFINITY_LABELS[columnName]}: {nft[columnName] ?? '—'}
              </Text>
            ))}
          </View>
        </View>
      )}
    </TouchableOpacity>
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
  },
  subtitle: {
    fontSize: 13,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8,
  },
  resetFiltersButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginHorizontal: 12,
    marginBottom: 10,
    alignSelf: 'flex-start',
  },
  resetFiltersButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  listContent: {
    paddingBottom: 24,
  },
  stepHeader: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  stepLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  filterBlock: {
    marginBottom: 8,
  },
  filterRow: {
    marginBottom: 10,
  },
  // The Allow +/-1 toggle - a label/hint column next to the Switch
  // itself, rather than stacked like the rest of filterRow's contents,
  // since a Switch reads best sitting right next to what it controls.
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  toggleTextColumn: {
    flex: 1,
  },
  filterLabel: {
    fontSize: 13,
    marginBottom: 2,
  },
  filterHint: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  pickerWrapper: {
    borderRadius: 6,
    borderWidth: 1,
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rangeInput: {
    flex: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
  },
  rangeSeparator: {
    color: '#999',
  },
  groupHeaderButton: {
    paddingVertical: 6,
  },
  groupHeaderText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // The Target Affinities picker - a row of tappable chips (one per
  // Affinity) instead of a single-select dropdown, since up to two can
  // be chosen at once (see handleToggleTargetAffinity).
  affinityChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  affinityChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  affinityChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  resultsCountLine: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 10,
  },
  selectedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginBottom: 10,
  },
  selectedInfoColumn: {
    marginLeft: 10,
    flex: 1,
    gap: 3,
  },
  selectedIdLine: {
    fontSize: 12,
    fontWeight: '700',
  },
  selectedLine: {
    fontSize: 13,
  },
  changeButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  changeButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  disclaimerBanner: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  disclaimerText: {
    fontSize: 12,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    marginHorizontal: 12,
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  idLine: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  // MatchRow overrides `row`'s own flexDirection: 'row' with a plain
  // vertical stack instead - `row` still supplies the shared padding/
  // border/shadow every row (PickRow included) uses, this just changes
  // the direction its children lay out in. rowMainContent below then
  // recreates the thumbnail+info side-by-side layout PickRow gets for
  // free from `row` itself, and the expanded comparison strip (see
  // MatchRow's own comment above) sits below rowMainContent as a
  // second, full-width child, rather than nested inside either column.
  matchRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  rowMainContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
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
    gap: 4,
  },
  line: {
    fontSize: 14,
  },
  highlightedLine: {
    fontWeight: '700',
  },
  tapHint: {
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 2,
  },
  // The expanded comparison strip - a full-width row of its own two
  // halves, each just a header plus one line per Affinity. Sitting
  // below rowMainContent rather than inside either of its columns is
  // what gives both halves the room to fit their headers on one line
  // AND keeps them starting at the same height - see MatchRow's own
  // comment above. The two halves are deliberately NOT an even 50/50
  // split - compareColumnLeft/Right instead mirror thumbnail/
  // infoColumn's own width and marginLeft exactly, so "this
  // candidate"'s Affinity lines land at the same left edge as
  // "Procreations Left"/"Ancestry" directly above them, per feedback.
  compareBlock: {
    flexDirection: 'row',
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 8,
  },
  compareColumnLeft: {
    width: 112,
  },
  compareColumnRight: {
    flex: 1,
    marginLeft: 12,
  },
  compareHeader: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  compareLine: {
    fontSize: 12,
    marginBottom: 2,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
    marginHorizontal: 24,
    lineHeight: 20,
  },
});
