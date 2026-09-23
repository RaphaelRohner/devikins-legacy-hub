/**
 * CollectionView.js
 *
 * The content shown for whichever tab is currently active (Devikins,
 * Weapons, or Equipment): the filter controls on top, and the filtered
 * list of NFTs below it. Handles three distinct situations gracefully:
 *
 *   1. No wallet has been fetched yet -> a hint message.
 *   2. A wallet was fetched but holds nothing in THIS collection -> a
 *      plain "you don't have any of these" message, not an error.
 *   3. Filters are active but nothing matches them -> a different message
 *      explaining that filters (not an empty wallet) are why the list is
 *      empty.
 *
 * Every collection now has its own compact summary row (see
 * SUMMARY_ROW_COMPONENTS below), so this also handles a fourth thing:
 * tapping an item in the list. The list shows that collection's summary
 * row (a compact picture + a few key fields); tapping one switches this
 * whole view to show that item's full NftCard instead, with a "Back"
 * link to return to the list.
 *
 * Filtering itself is split across two places, per feedback that the
 * "Show/Hide filters" toggle and "Apply/Remove Filters" button should
 * stay fixed on screen while the individual filter rows underneath them
 * scroll with the list:
 *   - THIS file owns most of the filter STATE (what's picked but not
 *     yet applied, what's actually applied) and renders the Apply/
 *     Remove button as a plain sibling directly above the FlatList -
 *     never inside it, so it can never be scrolled out of view no
 *     matter how tall the filter list gets. `expanded` (whether the
 *     panel below is open) is the one exception - it's a prop from
 *     App.js now, not local state, since the "Show/Hide filters" button
 *     that used to live right here moved up to App.js's own search row
 *     (to sit together with Search and Sort as one row/unit - see
 *     App.js's own comment). List/Tiles took over this row's now-empty
 *     anchor spot in its place - see the JSX below.
 *   - FilterPanel.js renders the actual rows (dropdowns / min-max boxes)
 *     and is only ever placed inside the FlatList's `ListHeaderComponent`
 *     - and only while `expanded` is true - so it scrolls together with
 *     the results underneath it, and disappears entirely once the
 *     Apply/Remove button is pressed (see handleApplyPress/
 *     handleRemovePress below, which both close the panel again).
 *
 * The star-rating filter (starFilter prop, applied value owned by
 * App.js so it can carry over between Devikins/Weapons/Equipment - see
 * App.js's own comment) used to apply the instant you tapped a star,
 * separately from the trait filters' pending/Apply flow. Per feedback
 * that this was confusing - it narrowed the list immediately but the
 * Filters panel stayed open, so you had to manually hide it to actually
 * see the (already narrowed) results, and no "Apply Filters" button
 * ever appeared for a star-only change - it's now folded into the same
 * flow as every other filter: tapping a star only updates
 * `pendingStarFilter` (local to this component), and it only reaches
 * the actual query (and bubbles up to App.js via onStarFilterChange)
 * once Apply Filters is pressed, same as any trait filter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView, Switch, BackHandler, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FilterPanel, { NO_FILTER, humanizeColumnName } from './FilterPanel';
import { getTileColumns, getCenteredContentPadding } from '../constants/layout';
import NftCard from './NftCard';
import NftTile from './NftTile';
import DevikinSummaryRow from './DevikinSummaryRow';
import WeaponSummaryRow from './WeaponSummaryRow';
import EquipmentSummaryRow from './EquipmentSummaryRow';
import { queryNfts, countNfts, getDistinctColumnValues, getColumnRange } from '../db/database';
import { COLLECTIONS, TRAIT_COLUMNS, RARITY_ORDER } from '../constants/schema';
import { useTheme } from '../context/ThemeContext';

// Which collections show a compact tappable summary row (with a
// separate detail view) vs. their full NftCard directly in the list.
// Add a new kind here (and its own SummaryRow component) to give another
// collection the same tap-to-open treatment.
const SUMMARY_ROW_COMPONENTS = {
  devikin: DevikinSummaryRow,
  weapon: WeaponSummaryRow,
  equipment: EquipmentSummaryRow,
};

export default function CollectionView({ kind, ownerAddresses, refreshKey, searchText = '', starFilter = 0, onStarFilterChange, viewMode = 'list', onToggleViewMode, sortField = 'nonce', sortDirection = 'asc', expanded, setExpanded }) {
  const { colors } = useTheme();
  // For the floating "Filters ✕" pill below (see hasAppliedFilters'
  // JSX further down) - keeps it clear of the phone's own home
  // indicator / gesture bar rather than sitting flush against the
  // very bottom edge.
  const insets = useSafeAreaInsets();

  // Tablet support: how many tiles fit per row, and how much extra
  // padding a single-column list row or the detail view needs so it
  // doesn't stretch edge-to-edge on a much wider screen - see
  // src/constants/layout.js. useWindowDimensions (rather than a one-
  // time Dimensions.get()) means both update live on rotation or an
  // iPad's split-screen resizing, not just at first render.
  const { width: windowWidth } = useWindowDimensions();
  const tileColumns = getTileColumns(windowWidth);
  const centeredContentPadding = getCenteredContentPadding(windowWidth);
  const [filters, setFilters] = useState({});
  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Remembers which kind (devikin/weapon/equipment) `rows` currently
  // holds data for - see reloadRows below for why.
  const previousKindRef = useRef(kind);

  // The "Deleted" switch next to the filters toggle - off by default, so
  // items marked deleted still show (just greyed-out, see the summary row
  // components) rather than disappearing the moment they're marked.
  // Switching this on excludes them from the query entirely.
  const [excludeDeleted, setExcludeDeleted] = useState(false);

  // How many NOT-deleted items this wallet has in this category - shown
  // next to "Show filters" as a quick "142 Devikins"-style count. This is
  // deliberately its own number, not tied to the filters or the Deleted
  // switch above - it's meant to answer "how many active items do I
  // have here", not "how many rows are in the currently-filtered list".
  const [notDeletedCount, setNotDeletedCount] = useState(0);

  // Which item (by nonce) is currently open in detail view, if any. Only
  // meaningful for a kind listed in SUMMARY_ROW_COMPONENTS above.
  const [selectedNonce, setSelectedNonce] = useState(null);

  // List vs. Tiles - now owned by App.js and passed down as the
  // `viewMode` prop (per feedback, its own toggle moved up onto the top
  // search row, on the right side of the search field), rather than
  // this component owning that state itself. Still ONE shared choice
  // across Devikins/Weapons/Equipment either way - see App.js's own
  // comment for the persistence/sharing details (previously explained
  // here, back when this component owned the state directly). The
  // toggle button itself now lives down in this file's own filterBar
  // row instead (see the JSX below) - displaced from App.js's search
  // row once Filters moved up onto it, taking List/Tiles' old spot -
  // onToggleViewMode is what that button calls.
  // --- Filter state (moved here from FilterPanel.js so the toggle and
  // Apply/Remove button can be pinned outside the scrollable list while
  // still sharing this same state with the rows rendered inside it -
  // see the file comment above.) `expanded` itself moved the other
  // direction from viewMode above: it used to be local state here, but
  // once its OWN toggle button ("Show/Hide filters") moved up to
  // App.js's search row (swapping places with List/Tiles - see that
  // file's own comment), the open/closed state had to move up with it,
  // the same lift already done for sortField/viewMode. Everything else
  // in this block (pendingFilters, appliedFilters, the actual
  // filters used in the query) stays local here, unaffected - only the
  // panel's own open/closed flag moved. ---
  // availableOptions describes what CAN be filtered on right now, based
  // on what's actually in the database - e.g.
  //   { rarity: { kind: 'text', values: ['Common', 'Rare'] },
  //     scaling: { kind: 'integer', min: 72, max: 131 } }
  const [availableOptions, setAvailableOptions] = useState({});
  const [pendingFilters, setPendingFilters] = useState({});
  const [appliedFilters, setAppliedFilters] = useState({});
  // The star filter's own "picked but not yet applied" value - same
  // idea as pendingFilters above, just tracked separately since the
  // star filter isn't one of the derived trait columns. Starts in sync
  // with whatever's already applied (the starFilter prop from App.js).
  const [pendingStarFilter, setPendingStarFilter] = useState(starFilter);

  const reloadRows = useCallback(async () => {
    if (!ownerAddresses || ownerAddresses.length === 0) {
      setRows([]);
      setIsLoading(false);
      return;
    }

    // Only clear the currently-shown rows when we're switching to a
    // DIFFERENT collection (e.g. Devikins -> Weapons) - otherwise we'd
    // briefly show the wrong tab's items while the new one loads. A
    // same-kind reload (a background Fetch/Update finishing, applying
    // filters, flipping the Deleted switch, etc.) instead leaves the old
    // rows on screen until the new ones are ready and swaps them in
    // directly - no empty gap in between means the list never has
    // "nothing to scroll", which is what was causing it to jump back to
    // the top after every fetch.
    const kindChanged = previousKindRef.current !== kind;
    previousKindRef.current = kind;
    if (kindChanged) {
      setRows([]);
    }

    setIsLoading(true);
    const result = await queryNfts(kind, ownerAddresses, filters, excludeDeleted, searchText, starFilter, sortField, sortDirection);
    setRows(result);
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ownerAddresses, filters, excludeDeleted, refreshKey, searchText, starFilter, sortField, sortDirection]);

  useEffect(() => {
    reloadRows();
  }, [reloadRows]);

  // Leaving a detail view open across a tab switch (or a brand new
  // wallet) would be confusing - go back to the list whenever either of
  // those changes. Also collapse the filter panel if it was expanded -
  // per feedback that leaving it open across tabs was confusing (the
  // expanded rows are a different set of traits for each collection),
  // and this also means the filter options get a clean, fresh reload
  // next time you open the panel rather than showing whatever was
  // already loaded for the tab you just left.
  //
  // Also clears any applied/pending filters (rather than just collapsing
  // the panel) - each collection has its own trait columns, so a filter
  // picked for Devikins (e.g. a Rarity value) doesn't meaningfully carry
  // over to Weapons or Equipment anyway. Without this, the previous
  // tab's filters silently stayed active on the new tab (still narrowing
  // the list) even though the panel itself looked closed, and the
  // "Remove filters" button stayed visible with nothing visibly
  // "expanded" to explain why.
  useEffect(() => {
    setSelectedNonce(null);
    setExpanded(false);
    setPendingFilters({});
    setAppliedFilters({});
    setFilters({});
    // Drops any not-yet-applied star pick, same as the trait filters
    // above - but unlike them, snaps back to whatever's still actually
    // applied (starFilter) rather than to 0, since the star filter
    // itself is meant to carry over across tabs (see this file's own
    // comment at the top).
    setPendingStarFilter(starFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ownerAddresses]);

  // Makes Android's system Back button/gesture close an open NFT detail
  // view (back to this tab's list) instead of exiting the app - without
  // this, pressing Back while looking at one NFT would quit the app
  // entirely, since this app doesn't use a navigation library that would
  // normally handle that automatically. Only takes over Back while a
  // detail view is actually open (`isDetailViewOpen`, the same
  // condition the render logic below uses to decide whether to show
  // one) - otherwise it steps aside (returns false) and lets Android do
  // its normal thing. See App.js's matching listener for the Wallets
  // screen - the two never conflict, since this component isn't even
  // mounted while that screen is showing.
  const isDetailViewOpen = Boolean(SUMMARY_ROW_COMPONENTS[kind]) && selectedNonce !== null;
  useEffect(() => {
    function handleBackPress() {
      if (isDetailViewOpen) {
        setSelectedNonce(null);
        return true; // handled - don't also exit the app
      }
      return false; // no detail view open - let Android do its normal thing
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [isDetailViewOpen]);

  // Derives the filter options from what's actually in the database for
  // this wallet (moved here from FilterPanel.js - see the file comment
  // above, and FilterPanel.js's own comments, for why this is derived
  // rather than hardcoded). Reloaded whenever the underlying data might
  // have changed - that's what `refreshKey` is for (App.js increments it
  // after each fetch completes).
  useEffect(() => {
    let cancelled = false;

    async function loadAvailableOptions() {
      const traitColumns = TRAIT_COLUMNS[kind];
      const options = {};

      for (const [columnName, definition] of Object.entries(traitColumns)) {
        if (definition.filterable === false) continue;

        if (definition.kind === 'text') {
          const values = await getDistinctColumnValues(kind, columnName, ownerAddresses);

          // Rarity reads much better as an actual rarity ladder (Common
          // -> Eldritch) than the database's default alphabetical order
          // (which would list Common after Eldritch) - see RARITY_ORDER's
          // own comment in schema.js. Every other text filter keeps the
          // alphabetical order the database already returned.
          if (columnName === 'rarity') {
            values.sort((a, b) => {
              const indexA = RARITY_ORDER.indexOf(a);
              const indexB = RARITY_ORDER.indexOf(b);
              // A rarity we don't recognize yet (e.g. the game adds a
              // new tier before this list is updated) sorts after all
              // the known ones, rather than disappearing or crashing.
              if (indexA === -1 && indexB === -1) return a.localeCompare(b);
              if (indexA === -1) return 1;
              if (indexB === -1) return -1;
              return indexA - indexB;
            });
          }

          if (values.length > 0) {
            options[columnName] = { kind: 'text', values };
          }
        } else {
          const { min, max } = await getColumnRange(kind, columnName, ownerAddresses);
          if (min !== null && max !== null) {
            options[columnName] = { kind: 'integer', min, max };
          }
        }
      }

      if (!cancelled) {
        setAvailableOptions(options);
      }
    }

    if (ownerAddresses && ownerAddresses.length > 0) {
      loadAvailableOptions();
    }

    return () => {
      cancelled = true;
    };
  }, [kind, ownerAddresses, refreshKey]);

  // Keeps the "142 Devikins" count next to "Show filters" up to date.
  // Always counts with deleted items excluded, regardless of the Deleted
  // switch's own current position - see the state comment above.
  useEffect(() => {
    let cancelled = false;

    async function loadNotDeletedCount() {
      if (!ownerAddresses || ownerAddresses.length === 0) {
        if (!cancelled) setNotDeletedCount(0);
        return;
      }
      const count = await countNfts(kind, ownerAddresses, true);
      if (!cancelled) setNotDeletedCount(count);
    }

    loadNotDeletedCount();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ownerAddresses, refreshKey]);

  function handleTextFilterChange(columnName, value) {
    const nextFilters = { ...pendingFilters };
    if (value === NO_FILTER) {
      delete nextFilters[columnName];
    } else {
      nextFilters[columnName] = value;
    }
    setPendingFilters(nextFilters);
  }

  function handleRangeFilterChange(columnName, bound, text) {
    const nextFilters = { ...pendingFilters };
    const existingRange = nextFilters[columnName] || {};
    const updatedRange = { ...existingRange, [bound]: text };

    // If the user has cleared both boxes, drop the filter entirely rather
    // than keeping an empty { min: '', max: '' } object around.
    const minIsEmpty = updatedRange.min === undefined || updatedRange.min === '';
    const maxIsEmpty = updatedRange.max === undefined || updatedRange.max === '';
    if (minIsEmpty && maxIsEmpty) {
      delete nextFilters[columnName];
    } else {
      nextFilters[columnName] = updatedRange;
    }

    setPendingFilters(nextFilters);
  }

  // Only now does the actual database query find out about the
  // selection - see the file comment at the top. Also closes the
  // (scrollable) filter rows panel, per feedback that the filter rows
  // should disappear once you've actually applied your pick. Includes
  // the star pick too now (onStarFilterChange bubbles it up to App.js,
  // which is what actually feeds it to the query - see CollectionView's
  // own starFilter prop/reloadRows).
  function handleApplyPress() {
    setAppliedFilters(pendingFilters);
    setFilters(pendingFilters);
    onStarFilterChange(pendingStarFilter);
    setExpanded(false);
  }

  // Clears everything - both what's applied and what's showing in the
  // controls - and re-queries with no filter at all. This is what the
  // button above turns into once filters are actually applied and
  // there's nothing new pending, per feedback: a quick way to undo the
  // whole selection rather than having to change each control back to
  // "All" by hand. Also closes the filter rows panel, same as Apply.
  // Clears the star pick too, same as every trait filter.
  function handleRemovePress() {
    setPendingFilters({});
    setAppliedFilters({});
    setFilters({});
    setPendingStarFilter(0);
    onStarFilterChange(0);
    setExpanded(false);
  }

  if (!ownerAddresses || ownerAddresses.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Add a wallet address (via the Wallets button) and tap Fetch/Update to get started.
        </Text>
      </View>
    );
  }

  // Detail view: only reachable for a kind with its own summary row, and
  // only while the tapped nonce is still present in the current
  // (filtered) rows - if a filter change makes it disappear, we fall back
  // to the list rather than show a detail view for an item that's no
  // longer part of the results.
  // Reuses isDetailViewOpen (set up above, right next to the Back-button
  // handling that depends on the exact same condition) rather than
  // recomputing it separately here.
  const selectedRow = isDetailViewOpen
    ? rows.find((row) => row.nonce === selectedNonce)
    : null;

  if (selectedRow) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <TouchableOpacity
          style={[styles.backButton, { backgroundColor: colors.primary }]}
          onPress={() => setSelectedNonce(null)}
        >
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <ScrollView contentContainerStyle={[styles.detailScrollContent, { paddingHorizontal: centeredContentPadding }]}>
          <NftCard kind={kind} nft={selectedRow} onNftUpdated={reloadRows} />
        </ScrollView>
      </View>
    );
  }

  // Broadened for V2: this collection can now come up empty because of
  // the top search bar's search text or exact star-rating filter (both
  // passed down from App.js), not just the per-collection trait filters
  // this component already manages - all three narrow the same query
  // (see queryNfts in database.js), so all three should count toward
  // "filters are why this list is empty" for the empty-state message
  // below.
  const hasActiveFilters =
    Object.keys(filters).length > 0 || searchText.trim().length > 0 || starFilter > 0;

  // Builds the human-readable "Rarity: Common, Rating: 4 stars, ..."
  // list used in the empty-state message below - per feedback that once
  // the collection tabs moved inside the hamburger menu, a bare "No
  // NFTs match these filters" no longer made it obvious which tab you
  // were even looking at, or what was actually applied. Search comes
  // first (it's the top bar, above everything else), then the star
  // Rating (the top row of the Filters panel), then the trait filters
  // in the same order FilterPanel.js lists them (TRAIT_COLUMNS' own
  // declaration order for this kind - see schema.js), so this always
  // reads in the same order the controls that produced it are shown in.
  // Returns an array (not a joined string) - the empty-state message
  // below needs the count too, to pick "filter" vs "filters".
  function describeActiveFilters() {
    const parts = [];

    const trimmedSearch = searchText.trim();
    if (trimmedSearch.length > 0) {
      parts.push(`Search: "${trimmedSearch}"`);
    }

    if (starFilter > 0) {
      parts.push(`Rating: ${starFilter} star${starFilter === 1 ? '' : 's'}`);
    }

    for (const columnName of Object.keys(TRAIT_COLUMNS[kind])) {
      const filterValue = filters[columnName];
      if (filterValue === undefined || filterValue === null || filterValue === '') continue;

      const label = humanizeColumnName(columnName);
      if (TRAIT_COLUMNS[kind][columnName].kind === 'text') {
        parts.push(`${label}: ${filterValue}`);
        continue;
      }

      // Numeric range filter - mirrors queryNfts' own >=/<= handling in
      // database.js, so the wording matches what's actually applied.
      const hasMin = filterValue.min !== undefined && filterValue.min !== null && filterValue.min !== '';
      const hasMax = filterValue.max !== undefined && filterValue.max !== null && filterValue.max !== '';
      if (hasMin && hasMax) {
        parts.push(`${label}: ${filterValue.min} to ${filterValue.max}`);
      } else if (hasMin) {
        parts.push(`${label}: ${filterValue.min} or more`);
      } else if (hasMax) {
        parts.push(`${label}: ${filterValue.max} or less`);
      }
    }

    return parts;
  }

  // The actual empty-state sentence, built here rather than inline in
  // the JSX below since it needs a little grammar: "Weapons NFTs match"
  // reads wrong (a plural noun modifying another noun, per feedback
  // from a non-native-speaker read) - dropping "NFTs" and using the
  // collection name on its own fixes that, and matches the sibling
  // "This wallet doesn't hold any Weapons yet" message's own phrasing.
  // "filter" vs "filters" agrees with how many are actually listed,
  // rather than the "filter(s)" shorthand this replaced.
  const activeFilterParts = hasActiveFilters ? describeActiveFilters() : [];
  const emptyStateMessage = hasActiveFilters
    ? `No ${COLLECTIONS[kind].label} match the ${activeFilterParts.length === 1 ? 'filter' : 'filters'}: ${activeFilterParts.join(', ')}`
    : `This wallet doesn't hold any ${COLLECTIONS[kind].label} yet.`;

  // Whether anything picked in the controls hasn't been applied yet -
  // the "Apply Filters" button only shows up (below the toggle row)
  // once this is true, so there's nothing to tap when there's nothing
  // new to do (a plain object comparison won't work here since these
  // are freshly-built objects each time, so this compares their
  // contents instead). Includes the star pick, so tapping a star alone
  // (with no trait filter touched) makes Apply Filters appear too.
  const hasPendingChanges =
    JSON.stringify(pendingFilters) !== JSON.stringify(appliedFilters) ||
    pendingStarFilter !== starFilter;
  // Whether a filter selection is actually live right now - drives the
  // floating "Filters ✕" pill at the bottom of the screen (see its own
  // JSX further down, after the FlatList), so a filter can be cleared
  // in one tap without opening the panel first. Includes the star
  // filter, so it still shows up (and still clears it) when a star
  // rating is the only thing currently narrowing the list.
  const hasAppliedFilters = Object.keys(appliedFilters).length > 0 || starFilter > 0;

  // The item count and Deleted switch. Used to be shared between two
  // JSX spots (this row, or a second row below it, depending on
  // whether "Remove filters" needed the space) - now that button
  // floats at the bottom of the screen instead of living in this row,
  // there's only ever one spot, so nothing about this pair moves
  // around anymore. Kept as its own variable regardless, since it's
  // still one clearly-scoped chunk of JSX either way.
  const countAndDeletedSwitch = (
    <>
      {/* "142 Devikins" - how many active (not-deleted) items this
          wallet has in this category. See the notDeletedCount
          state/effect above for why this always counts with deleted
          items excluded, regardless of the switch below.
          position: 'absolute' + left/right: 0 (countTextWrap) centers
          this purely on whichever row it's placed in, completely
          ignoring how wide the Deleted switch (or List/Tiles button)
          next to it is - that's what makes it land at TRUE center
          instead of drifting toward whichever side has less content.
          pointerEvents="none" is required now that this sometimes
          shares a row with the List/Tiles button - since the box
          spans the row edge-to-edge (left: 0, right: 0) to center
          itself, without this it would sit on top of the button and
          absorb taps meant for it.
          Set on a wrapping View rather than directly on the <Text>
          below: pointerEvents="none" on a bare <Text> was unreliable on
          Android in testing (worked sometimes, not others) - wrapping
          it in a plain View and putting pointerEvents there instead is
          the more dependable way to do this on Android. */}
      <View pointerEvents="none" style={styles.countTextWrap}>
        <View style={[styles.countPill, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.countText, { color: colors.secondaryText }]}>
            {notDeletedCount} {COLLECTIONS[kind].label}
          </Text>
        </View>
      </View>

      {/* Off by default (deleted items stay visible, just greyed out -
          see the summary row components). Switching this on excludes
          them from the list entirely, until switched back off again.
          Given the same border/background pill treatment as the count
          above and every other control in this row, per feedback - the
          actual Switch stays a real native Switch rather than becoming
          a custom tap-to-flip button, since its track color is what
          shows the current on/off state at a glance; only the
          surrounding box is new. */}
      <View style={[styles.deletedSwitchGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.deletedSwitchLabel, { color: colors.text }]}>Deleted</Text>
        <Switch
          value={excludeDeleted}
          onValueChange={setExcludeDeleted}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={colors.surface}
        />
      </View>
    </>
  );

  const filterableColumnNames = Object.keys(availableOptions);

  // The filter panel used to sit above the list as a separate, non-
  // scrolling View - fine while collapsed, but once expanded (a Devikin
  // can have over 20 filterable traits, each its own row) it could
  // easily grow taller than the screen, with nothing below it -
  // including the list itself - reachable by scrolling. The rows below
  // (FilterPanel, inside ListHeaderComponent) fix that by scrolling
  // together with the list; the toggle + Apply/Remove button just below
  // are a separate, plain sibling of the FlatList, so they stay fixed on
  // screen the whole time, however far you scroll.
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {filterableColumnNames.length > 0 && (
        <View style={[styles.filterBar, { backgroundColor: colors.toolbarBackground, borderBottomColor: colors.toolbarDivider }]}>
          {/* One row: the List/Tiles toggle on the left, the item
              count centered, the Deleted switch on the right - always,
              regardless of whether a filter's applied. Used to make
              room for a "Filters ✕" button here too by dropping the
              count/switch onto their own second row whenever a filter
              was applied - per later feedback that the row appearing/
              disappearing broke the now-more-polished toolbar's
              consistency once List/Tiles, the count, and Deleted all
              got their own button styling too. "Filters ✕" moved out
              of this row entirely instead - it now floats at the
              bottom of the screen instead (see hasAppliedFilters' JSX
              further down, after the FlatList) - so this row's height
              never changes.

              List/Tiles wasn't always the button anchoring this row's
              left side - "Show filters ▼ / Hide filters ▲" used to sit
              here instead, until Filters moved up to join Search and
              Sort on App.js's own row per feedback (so all three of
              Search/Sort/Filters could sit together, in that order).
              List/Tiles, displaced from that row by Filters, took over
              this spot rather than needing a new one of its own. */}
          <View style={styles.toggleRow}>
            <TouchableOpacity
              style={[styles.anchorToggleButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={onToggleViewMode}
            >
              <Text style={[styles.anchorToggleText, { color: colors.secondaryText }]}>
                {viewMode === 'list' ? 'List' : 'Tiles'}
              </Text>
            </TouchableOpacity>

            {countAndDeletedSwitch}
          </View>

          {expanded && hasPendingChanges && (
            <TouchableOpacity
              style={[styles.applyButton, { backgroundColor: colors.primary }]}
              onPress={handleApplyPress}
            >
              <Text style={[styles.applyButtonText, { color: colors.primaryText }]}>Apply Filters</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      <FlatList
        // React Native doesn't support changing numColumns on an
        // already-mounted FlatList - it throws ("Changing numColumns on
        // the fly is not supported"). Keying the list by viewMode AND
        // tileColumns forces React to unmount and remount a fresh
        // FlatList instance whenever List/Tiles is toggled, or whenever
        // tileColumns itself changes (e.g. rotating a tablet) - either
        // one sidesteps that restriction the same way.
        key={`${viewMode}-${tileColumns}`}
        data={rows}
        keyExtractor={(item) => String(item.nonce)}
        numColumns={viewMode === 'tiles' ? tileColumns : 1}
        columnWrapperStyle={viewMode === 'tiles' ? styles.tilesRow : undefined}
        renderItem={({ item }) => {
          if (viewMode === 'tiles') {
            return <NftTile nft={item} onPress={() => setSelectedNonce(item.nonce)} columns={tileColumns} />;
          }
          const SummaryRow = SUMMARY_ROW_COMPONENTS[kind];
          return SummaryRow ? (
            <SummaryRow nft={item} onPress={() => setSelectedNonce(item.nonce)} />
          ) : (
            <NftCard kind={kind} nft={item} onNftUpdated={reloadRows} />
          );
        }}
        ListHeaderComponent={
          expanded ? (
            <FilterPanel
              kind={kind}
              availableOptions={availableOptions}
              pendingFilters={pendingFilters}
              onTextFilterChange={handleTextFilterChange}
              onRangeFilterChange={handleRangeFilterChange}
              starFilter={pendingStarFilter}
              onStarFilterChange={setPendingStarFilter}
            />
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator style={styles.loadingSpinner} color={colors.primary} />
          ) : (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
                {emptyStateMessage}
              </Text>
            </View>
          )
        }
        contentContainerStyle={[
          viewMode === 'tiles'
            ? styles.tilesListContent
            : [styles.listContent, { paddingHorizontal: centeredContentPadding }],
          // Extra room at the bottom only while the floating "Filters
          // ✕" pill below is showing, so the last row of the list can
          // still scroll clear of it rather than sitting hidden behind
          // it.
          hasAppliedFilters && styles.listContentWithFloatingButton,
        ]}
      />

      {/* Floats over the list rather than living inline in toggleRow
          above (where it used to sit, pushing the count/Deleted switch
          onto their own extra row whenever a filter was applied) - per
          feedback that the row appearing/disappearing broke the
          toolbar's now-more-consistent look. position: 'absolute' on
          the OUTER wrap (full width, centered content) rather than on
          the button itself is what centers it purely against the
          screen's own width regardless of anything else on screen -
          same centering technique as countTextWrap above, for the same
          reason. pointerEvents="box-none" (not "none", unlike
          countTextWrap) is required here specifically because this
          wrap DOES contain something tappable - "none" would also
          block taps on the button itself, not just the empty space
          around it; "box-none" lets the empty space pass taps through
          to the list underneath while the button stays tappable.
          insets.bottom clears the phone's own home indicator/gesture
          bar rather than sitting flush against the true bottom edge -
          same reasoning SortPickerModal.js already uses insets.bottom
          for. Shadow/elevation match the app's existing card-shadow
          recipe (see e.g. DevikinSummaryRow.js), just applied here so
          this reads as floating above the list rather than sitting
          flush on it. */}
      {hasAppliedFilters && (
        <View
          pointerEvents="box-none"
          style={[styles.floatingRemoveWrap, { bottom: insets.bottom + 16 }]}
        >
          <TouchableOpacity
            style={[
              styles.removeButton,
              styles.floatingRemoveButton,
              { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: colors.cardShadow },
            ]}
            onPress={handleRemovePress}
          >
            <Text style={[styles.removeLinkText, { color: colors.cancelText }]}>Filters ✕</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Spaces tiles evenly across each row of 3 (see FlatList's
  // columnWrapperStyle, only used in Tiles mode) - NftTile.js's own
  // flexBasis: '31%' plus this space-between is what leaves an even gap
  // between all three tiles without needing to hardcode exact margins.
  tilesRow: {
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  tilesListContent: {
    paddingTop: 4,
    paddingBottom: 12,
  },
  // The fixed toggle + Apply/Remove button bar - a plain sibling of the
  // FlatList below, never inside it, so it can never scroll out of view
  // no matter how many filter rows are showing. See the file comment at
  // the top for the full reasoning. Also the last of the three control
  // rows that share the app's toolbarBackground color (menuRow/
  // searchRow in App.js are the other two) - the borderBottomWidth/
  // Color here is what actually separates that whole three-row toolbar
  // from the list below, per feedback wanting a visible line there,
  // since matching colors alone (colors.background below vs
  // colors.toolbarBackground here) wasn't guaranteed to read as a
  // clean boundary in every theme without one.
  filterBar: {
    paddingHorizontal: 12,
    paddingTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Used to only carry top padding, with a second row (secondaryRow,
  // removed - see below) providing the bottom padding on the (common)
  // occasions it rendered. Now that the count/Deleted switch never
  // move to a second row anymore (see countAndDeletedSwitch's own
  // comment above) and "Filters ✕" floats at the bottom of the screen
  // instead of living in this row, this is simply the row's own top
  // AND bottom padding, always - no more conditional toggleRowLast
  // variant needed.
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
    // Required so the count text can center itself with position:
    // 'absolute' against THIS row - see countTextWrap's own comment.
    position: 'relative',
  },
  // Turned into a real button (background, border, generous padding)
  // rather than bare colored text, per feedback from an Android
  // touch-target audit - this and removeButton below were the two
  // smallest tap targets in the whole app (no padding at all, just the
  // text itself), so they got the biggest bump. Originally the "Show/
  // Hide filters" button specifically (hence the name) - now reused for
  // the List/Tiles toggle that took over this same anchor spot once
  // Filters moved up to App.js's row instead. Kept the generic name
  // since it just describes the SLOT (this row's left-anchoring
  // button), not any longer tied to which control sits in it.
  anchorToggleButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
    justifyContent: 'center',
  },
  anchorToggleText: {
    fontWeight: '600',
  },
  countText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  // Pulls the count text out of the row's normal flow entirely and
  // centers it purely against the row's own width (left: 0, right: 0,
  // alignItems: 'center'). This is deliberately independent of whatever
  // else is in the row - an earlier version tried to center it with a
  // pair of equal flex: 1 spacers instead, but React Native flex items
  // don't shrink below their content size by default, so the side
  // holding the wider Deleted switch quietly claimed more than half the
  // row and dragged the count off-center. Absolute positioning has no
  // such issue, since it ignores siblings altogether.
  // Wraps the count Text so pointerEvents="none" can be set on a plain
  // View (see the JSX comment above for why it's here and not directly
  // on the Text). alignItems: 'center' is what centers the count PILL
  // itself within this full-width wrapper now (added once the count
  // became a real bordered/background pill rather than bare Text - the
  // old textAlign: 'center' on countText handled centering back when
  // this View just stretched plain text across its full width; a pill
  // with its own border shouldn't stretch that way, so alignItems here
  // took over that job instead).
  countTextWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  // The count's actual visible box, per feedback wanting it (and the
  // Deleted switch below) to look like the row's other buttons rather
  // than bare text/controls with no border - same height as
  // anchorToggleButton above (List/Tiles), which this and
  // deletedSwitchGroup below are both matched to explicitly.
  countPill: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 8,
  },
  // height/borderWidth/borderRadius/paddingHorizontal are the same
  // button treatment as countPill above, for the same reason -
  // flexDirection/alignItems/gap (already here beforehand) are what
  // actually lay out the label next to the Switch inside that box.
  deletedSwitchGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  deletedSwitchLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Same button treatment as anchorToggleButton above, for the same
  // reason - see its comment. Also pinned to the same explicit height
  // now, for the same reason anchorToggleButton is - it used to match
  // that button only because both happened to share the same
  // paddingVertical number, which would have silently drifted apart
  // once anchorToggleButton moved to an explicit height instead.
  removeButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 40,
    justifyContent: 'center',
  },
  removeLinkText: {
    fontWeight: '600',
    fontSize: 13,
  },
  // Centers the floating "Filters ✕" button purely against the
  // screen's own width, the same absolute-positioning technique
  // countTextWrap above uses for the same reason (ignoring whatever
  // else is on screen rather than trying to balance around it). `left:
  // 0, right: 0` span the full width; `alignItems: 'center'` is what
  // then centers the button itself within that span, since (unlike
  // countTextWrap's plain centered text) this wraps a normal button
  // that shouldn't stretch to fill it. `bottom` is set inline per
  // instance (see the JSX), since it depends on the device's own
  // safe-area inset.
  floatingRemoveWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  // Same shadow/elevation recipe the app's cards already use (see e.g.
  // DevikinSummaryRow.js's own `row` style) - shadowColor comes from
  // the theme inline (see the JSX), the rest is fixed here. Reads as
  // floating above the list rather than a button that just happens to
  // sit on top of it.
  floatingRemoveButton: {
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  applyButton: {
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  applyButtonText: {
    fontWeight: '600',
  },
  loadingSpinner: {
    marginTop: 24,
  },
  emptyContainer: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    textAlign: 'center',
  },
  listContent: {
    paddingVertical: 12,
  },
  // Applied on top of tilesListContent/listContent above (not instead
  // of) only while the floating "Filters ✕" pill is showing - see the
  // FlatList's own contentContainerStyle. Bigger than either one's own
  // paddingBottom so the last row can still scroll clear of the pill
  // sitting over it, rather than ending up permanently hidden behind
  // it.
  listContentWithFloatingButton: {
    paddingBottom: 76,
  },
  // Made into a proper button (filled background, rounded corners)
  // rather than a plain text link, per feedback that it was easy to
  // miss - same look as App.js's Fetch/Update button, for consistency.
  // This is shared code, so the change applies to all three tabs at
  // once (Devikins, Weapons, Equipment all go through this same detail
  // view).
  // Was briefly stretched edge-to-edge with a full "‹ Back to Home"
  // label per earlier feedback; shortened again to just a small round
  // "‹" icon button (top-left corner) per later feedback, matching the
  // same icon-only back button now used by WalletManager.js,
  // Feedback.js, and HelpAssistant.js.
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginHorizontal: 12,
    marginVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  detailScrollContent: {
    paddingBottom: 24,
  },
});
