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
 *
 * A fifth thing, added later: Compare mode. The Compare button next to
 * List/Tiles (see the JSX below) toggles compareMode on/off; while it's on, a
 * row tap adds/removes that item from compareSelection (capped at two -
 * see handleToggleCompareSelection) instead of opening its detail view,
 * and the row/tile itself gets a colored-border highlight (the `selected`
 * prop every summary row / NftTile now accepts). The moment a second
 * item is picked, compareNfts takes over the render and swaps in
 * CompareView.js - a full side-by-side listing of every stat/trait for
 * that kind - the same way selectedRow does for the ordinary detail
 * view. This is deliberately the lightweight version of "compare two
 * NFTs": it reuses whatever this list is already filtered/sorted/
 * searched to, rather than being a separate guided picker screen with
 * its own filter panel - see CompareView.js's own file comment for the
 * full reasoning.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView, Switch, BackHandler, PanResponder, useWindowDimensions } from 'react-native';
import FilterPanel, { NO_FILTER, humanizeColumnName } from './FilterPanel';
import { getTileColumns, getCenteredContentPadding } from '../constants/layout';
import NftCard from './NftCard';
import NftTile from './NftTile';
import DevikinSummaryRow from './DevikinSummaryRow';
import WeaponSummaryRow from './WeaponSummaryRow';
import EquipmentSummaryRow from './EquipmentSummaryRow';
import CompareView from './CompareView';
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

// Sizing/positioning for the floating "Filters ✕" button (see
// hasAppliedFilters' JSX further down). It used to float bottom-
// center, sized to match the row of buttons above it (paddingHorizontal
// 10, height 40) - per feedback it now floats top-right instead,
// roughly under the Deleted pill, and a bit bigger (height 40 -> 50,
// fontSize ~13 -> 17, see floatingRemoveButton/floatingRemoveButtonText
// below) so it reads as a more deliberate, separate control rather than
// one more toolbar button - a first pass at +50% (height 60) read as
// too big once actually seen on-device, so this settled at +25%
// instead. WIDTH_ESTIMATE is a guess at the button's actual rendered
// width (it isn't measured - RN can't know a View's size before it's
// laid out without an onLayout round-trip, which would make the button
// jump position on its first render each time the filters get
// applied); it only affects how far right the button's default/clamped
// position can go, so a slightly-off guess just means a little extra
// or missing breathing room on the right edge, not a broken layout.
const FLOATING_BUTTON_WIDTH_ESTIMATE = 145;
const FLOATING_BUTTON_HEIGHT = 50;
const FLOATING_BUTTON_TOP_DEFAULT = 68;
const FLOATING_BUTTON_RIGHT_DEFAULT = 12;
const FLOATING_BUTTON_EDGE_MARGIN = 8;
// How far a touch has to move before it's treated as a drag rather
// than a tap - see the PanResponder below.
const FLOATING_BUTTON_DRAG_THRESHOLD = 4;

export default function CollectionView({ kind, ownerAddresses, refreshKey, searchText = '', starFilter = 0, onStarFilterChange, viewMode = 'list', onSetViewMode, sortField = 'nonce', sortDirection = 'asc', expanded, setExpanded, onAppliedFiltersChange = () => {}, onStatusTextChange = () => {} }) {
  const { colors } = useTheme();

  // Tablet support: how many tiles fit per row, and how much extra
  // padding a single-column list row or the detail view needs so it
  // doesn't stretch edge-to-edge on a much wider screen - see
  // src/constants/layout.js. useWindowDimensions (rather than a one-
  // time Dimensions.get()) means both update live on rotation or an
  // iPad's split-screen resizing, not just at first render. `height`
  // is also used now, to keep the draggable "Filters ✕" button
  // (further down) from being dragged off the bottom of the screen.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
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

  // "Compare" mode - see the Compare toggle button in toggleRow below, and
  // this file's own top comment. Off by default; turning it on switches
  // row taps from opening the detail view to picking up to two NFTs to
  // compare instead (compareSelection, capped at two - see
  // handleToggleCompareSelection below). Once two are picked, compareNfts
  // (derived further down, right next to selectedRow) takes over the
  // render the same way selectedRow does for the ordinary detail view.
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState([]);

  // List vs. Tiles - now owned by App.js and passed down as the
  // `viewMode` prop (per feedback, its own toggle moved up onto the top
  // search row, on the right side of the search field), rather than
  // this component owning that state itself. Still ONE shared choice
  // across Devikins/Weapons/Equipment either way - see App.js's own
  // comment for the persistence/sharing details (previously explained
  // here, back when this component owned the state directly). The
  // toggle buttons themselves now live down in this file's own
  // filterBar row instead (see the JSX below) - displaced from App.js's
  // search row once Filters moved up onto it, taking List/Tiles' old
  // spot. Briefly a single merged toggle button down here too (per
  // feedback, back when this row was tight on space with Filters ✕
  // also living in it) - split back into two separate buttons once
  // Filters ✕ floated out of this row and left room again. onSetViewMode
  // is what each button calls, with its own target mode ('list' or
  // 'tiles') - unlike the merged version, which just flipped between
  // them.
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
    // Compare mode's own selection is just as tab-specific as the
    // filters above, for a sharper reason than "doesn't carry over
    // meaningfully": a nonce picked while looking at Devikins is a
    // *different NFT entirely* once kind switches to Weapons (nonces
    // aren't unique across collections) - left in place, a stale pick
    // from the old tab could silently pair with a freshly-picked item
    // on the new one. Compare mode itself (compareMode) stays on across
    // tabs, same as List/Tiles staying on - only the in-progress pick
    // is cleared.
    setCompareSelection([]);
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

  // Same idea as isDetailViewOpen above, for the comparison screen -
  // compareSelection reaching two is exactly the condition the render
  // logic further down uses to show CompareView.js instead of the list
  // (see compareNfts, right next to selectedRow below).
  const isCompareViewOpen = compareSelection.length === 2;

  useEffect(() => {
    function handleBackPress() {
      if (isCompareViewOpen) {
        handleCloseCompare();
        return true; // handled - don't also exit the app
      }
      if (isDetailViewOpen) {
        setSelectedNonce(null);
        return true; // handled - don't also exit the app
      }
      return false; // nothing open here - let Android do its normal thing
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [isDetailViewOpen, isCompareViewOpen]);

  // Turns Compare mode on/off (the Compare button in toggleRow below). Turning
  // it off also clears any in-progress selection, so switching it back on
  // later always starts fresh rather than remembering a stale pick.
  function handleToggleCompareMode() {
    setCompareMode((previous) => !previous);
    setCompareSelection([]);
  }

  // Adds/removes one NFT from the (at most two) being compared - tapping
  // an already-selected row deselects it, tapping a new one adds it.
  // Once two are selected, compareNfts (below) takes over the render
  // entirely, so there's never a third tap to handle here.
  function handleToggleCompareSelection(nonce) {
    setCompareSelection((previous) =>
      previous.includes(nonce) ? previous.filter((existing) => existing !== nonce) : [...previous, nonce]
    );
  }

  // Leaves the comparison screen back to this same (still Compare-mode)
  // list, selection cleared - same "back to where you were, not further
  // back" behavior as every other in-app back button/gesture.
  function handleCloseCompare() {
    setCompareSelection([]);
  }

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

  // Declared up here, ahead of every early `return` in this component
  // (the "no wallet yet" one right below, and the detail-view one
  // further down) rather than down next to hasAppliedFilters, where
  // this used to live and reads more naturally alongside it. React
  // requires every hook in a component to run in the exact same order
  // on every render, and an early return skips any hook declared after
  // it - with this block after the detail-view return, the list view
  // called one set of hooks and the detail view called fewer of them,
  // which crashed the app the moment a Devikin was tapped open
  // ("Rendered fewer hooks than expected"). Every hook this component
  // owns now runs unconditionally, before anything that could return
  // early.

  // Where the floating "Filters ✕" button currently sits, as an {x, y}
  // offset from its default top-right position (FLOATING_BUTTON_
  // TOP_DEFAULT/RIGHT_DEFAULT above) rather than an absolute screen
  // position - so the default spot (and the clamping below) only has
  // to be worked out once, and "not dragged yet" is simply {x: 0, y:
  // 0}. State drives the re-render that actually moves the button on
  // screen; the ref alongside it holds the same value for the
  // PanResponder callbacks below to read/write without waiting for a
  // re-render (and without going stale inside a closure captured at
  // the start of the gesture).
  const [floatingOffset, setFloatingOffset] = useState({ x: 0, y: 0 });
  const floatingOffsetRef = useRef(floatingOffset);
  // The offset at the moment the current drag started, so each move
  // event can compute the new position from gestureState's cumulative
  // dx/dy (measured from the touch's start, not the previous event)
  // without drifting.
  const dragStartOffsetRef = useRef({ x: 0, y: 0 });

  // Keeps the button from being dragged off-screen (or up under the
  // toolbar rows, or down past the bottom edge) - clamps to
  // FLOATING_BUTTON_EDGE_MARGIN px of breathing room on every side.
  // windowWidth/windowHeight (not the exact height of this component's
  // own container, which isn't directly knowable) are the best
  // available stand-in for "the visible screen," so this is an
  // approximation like the rest of the button's sizing/position - see
  // the constants' own comment above. X is worked out in terms of the
  // button's `right` distance from the screen's right edge (see the
  // JSX below for why), not a `left` position, so FLOATING_BUTTON_
  // WIDTH_ESTIMATE only has to be right enough to keep the button from
  // being dragged too far left off the screen - it no longer affects
  // where the button rests by default, which is now exact regardless
  // of the estimate (see the "resting position" screenshot feedback
  // that prompted this).
  function clampFloatingOffset(offset) {
    const minRight = FLOATING_BUTTON_EDGE_MARGIN;
    const maxRight = windowWidth - FLOATING_BUTTON_WIDTH_ESTIMATE - FLOATING_BUTTON_EDGE_MARGIN;
    const minX = FLOATING_BUTTON_RIGHT_DEFAULT - maxRight;
    const maxX = FLOATING_BUTTON_RIGHT_DEFAULT - minRight;
    const minY = FLOATING_BUTTON_EDGE_MARGIN - FLOATING_BUTTON_TOP_DEFAULT;
    const maxY = windowHeight - FLOATING_BUTTON_EDGE_MARGIN - FLOATING_BUTTON_HEIGHT - FLOATING_BUTTON_TOP_DEFAULT;
    return {
      x: Math.min(Math.max(offset.x, minX), maxX),
      y: Math.min(Math.max(offset.y, minY), maxY),
    };
  }

  // Makes the floating button draggable without pulling in a gesture
  // library (react-native-gesture-handler/reanimated) just for one
  // button - PanResponder ships with React Native itself. A tap still
  // works as a normal tap: onStartShouldSetPanResponder is false, so a
  // touch starts out belonging to the TouchableOpacity underneath (see
  // the JSX below) exactly as if this wrapper wasn't there at all;
  // onMoveShouldSetPanResponder only grabs the gesture, mid-touch, once
  // it's moved more than FLOATING_BUTTON_DRAG_THRESHOLD px - past that
  // point it's clearly a drag, not a tap, so the TouchableOpacity never
  // sees a move that large and won't also fire its onPress when the
  // finger lifts. A short tap that never crosses the threshold never
  // reaches the PanResponder at all, so it reaches the TouchableOpacity
  // completely normally.
  const floatingButtonPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        Math.abs(gestureState.dx) > FLOATING_BUTTON_DRAG_THRESHOLD ||
        Math.abs(gestureState.dy) > FLOATING_BUTTON_DRAG_THRESHOLD,
      onPanResponderGrant: () => {
        dragStartOffsetRef.current = floatingOffsetRef.current;
      },
      onPanResponderMove: (_evt, gestureState) => {
        const nextOffset = clampFloatingOffset({
          x: dragStartOffsetRef.current.x + gestureState.dx,
          y: dragStartOffsetRef.current.y + gestureState.dy,
        });
        floatingOffsetRef.current = nextOffset;
        setFloatingOffset(nextOffset);
      },
    })
  ).current;

  // Whether a filter selection is actually live right now - drives the
  // floating "Filters ✕" pill (see its own JSX further down, after the
  // FlatList), so a filter can be cleared in one tap without opening
  // the panel first. Includes the star filter, so it still shows up
  // (and still clears it) when a star rating is the only thing
  // currently narrowing the list. Used to live right next to where
  // it's used, further down - moved up here (its dependencies,
  // appliedFilters and starFilter, are both already available this
  // early) once the useEffect below needed it declared ahead of the
  // early returns too, for the same rules-of-hooks reason as the
  // floating-button state above.
  const hasAppliedFilters = Object.keys(appliedFilters).length > 0 || starFilter > 0;

  // Tells App.js whether a filter is currently applied, purely so the
  // Filters button itself (which lives up in App.js's own row) can
  // show the same active-state highlight List/Tiles already gets when
  // a filter's live - per feedback that this was the one control in
  // the toolbar that didn't say anything about its own current state,
  // unlike everything else in that row. Mirrors how starFilter changes
  // already bubble up via onStarFilterChange - onAppliedFiltersChange
  // is optional (defaults to a no-op below) so this component doesn't
  // break if a future caller doesn't pass it.
  useEffect(() => {
    onAppliedFiltersChange(hasAppliedFilters);
  }, [hasAppliedFilters, onAppliedFiltersChange]);

  // The text App.js now shows up in menuRow (the slot its ProgressBar
  // already uses) in place of this screen's own item count, which used
  // to live buried in the toolbar row below - see App.js's own
  // collectionStatusText comment for the full reasoning.
  //
  // This used to also double as Compare mode's "Tap one/one more to
  // compare" progress message while that was active, the same way it
  // briefly shared the count's old spot in the toolbar - reverted per
  // feedback, since that meant the count itself disappeared the moment
  // Compare mode turned on, which read as broken rather than helpful.
  // The count stays put here unconditionally now; Compare mode's own
  // progress hint moved down into this screen's own toolbar instead,
  // sitting inline right next to the Compare button that controls it (see
  // the JSX further down, inside viewModeButtonGroup).
  const toolbarStatusText = `${notDeletedCount} ${COLLECTIONS[kind].label}`;

  useEffect(() => {
    onStatusTextChange(toolbarStatusText);
  }, [toolbarStatusText, onStatusTextChange]);

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

  // The two NFTs currently picked for comparison, looked up from this
  // same (already filtered/sorted/searched) `rows` list - same "derive
  // from rows, don't keep a separate copy" approach as selectedRow just
  // above, including the same safety net: if a filter change or a
  // background refresh makes one of the two vanish from `rows` mid-
  // comparison (e.g. it gets marked Deleted while the Deleted switch is
  // on), `.every(Boolean)` catches the resulting `undefined` and falls
  // back to the list instead of handing CompareView.js a missing NFT.
  const compareCandidates = isCompareViewOpen
    ? compareSelection.map((nonce) => rows.find((row) => row.nonce === nonce))
    : null;
  const compareNfts = compareCandidates && compareCandidates.every(Boolean) ? compareCandidates : null;

  if (compareNfts) {
    return <CompareView kind={kind} nfts={compareNfts} onClose={handleCloseCompare} />;
  }

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
  // The Deleted switch - used to share this spot with the item count
  // too (hence the old name, countAndDeletedSwitch), until that count
  // moved up into App.js's own menuRow per feedback (see this file's
  // top comment, and App.js's collectionStatusText comment, for the
  // full reasoning: it was fighting the List/Tiles/Compare buttons for
  // room in an already-tight row, and menuRow already had a matching
  // blank slot doing nothing outside a fetch). Kept as its own variable
  // regardless, now just for this one control.
  const deletedSwitchControl = (
    <View style={[styles.deletedSwitchGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.deletedSwitchLabel, { color: colors.text }]}>Deleted</Text>
      <Switch
        value={excludeDeleted}
        onValueChange={setExcludeDeleted}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.surface}
      />
    </View>
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
          {/* One row: List and Tiles as two separate buttons on the
              left, the item count centered, the Deleted switch on the
              right - always, regardless of whether a filter's applied.
              List/Tiles used to be a single button that toggled
              between the two states (merged per earlier feedback, when
              this row was short on space) - split back into two once
              Filters moving up to App.js's row freed up room here
              again, so both options are visible/tappable at once
              rather than needing a second tap to see what you'd switch
              to. Tiles sits to the right of List per that feedback.
              Both share anchorToggleButton's base pill style; the
              active one additionally gets colors.primary/
              chipBackground (same active-state treatment
              FilterPanel.js's own option chips use) so it's clear at a
              glance which mode is currently showing.

              "Filters ✕" isn't in this row - it floats over the list
              instead (see hasAppliedFilters' JSX further down, after
              the FlatList), so this row's height never changes
              regardless of whether a filter's applied.

              List/Tiles wasn't always the button(s) anchoring this
              row's left side - "Show filters ▼ / Hide filters ▲" used
              to sit here instead, until Filters moved up to join
              Search and Sort on App.js's own row per feedback (so all
              three of Search/Sort/Filters could sit together, in that
              order). List/Tiles, displaced from that row by Filters,
              took over this spot rather than needing a new one of its
              own. */}
          <View style={styles.toggleRow}>
            <View style={styles.viewModeButtonGroup}>
              <TouchableOpacity
                style={[
                  styles.anchorToggleButton,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  viewMode === 'list' && { borderColor: colors.primary, backgroundColor: colors.chipBackground },
                ]}
                onPress={() => onSetViewMode('list')}
              >
                <Text style={[styles.anchorToggleText, { color: viewMode === 'list' ? colors.primary : colors.secondaryText }]}>
                  List
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.anchorToggleButton,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  viewMode === 'tiles' && { borderColor: colors.primary, backgroundColor: colors.chipBackground },
                ]}
                onPress={() => onSetViewMode('tiles')}
              >
                <Text style={[styles.anchorToggleText, { color: viewMode === 'tiles' ? colors.primary : colors.secondaryText }]}>
                  Tiles
                </Text>
              </TouchableOpacity>

              {/* Compare - see this file's own top comment and
                  CompareView.js. Started as a compact icon-only button
                  (a single "⇄" glyph, matching the app's own "‹"/"✕"
                  precedent for plain-icon controls) purely to save space
                  in an already-tight row - switched to a labeled pill
                  per feedback wanting it clearer at a glance what it
                  does, same treatment as List/Tiles right next to it. */}
              <TouchableOpacity
                style={[
                  styles.anchorToggleButton,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  compareMode && { borderColor: colors.primary, backgroundColor: colors.chipBackground },
                ]}
                onPress={handleToggleCompareMode}
                accessibilityLabel="Compare two NFTs"
              >
                <Text style={[styles.anchorToggleText, { color: compareMode ? colors.primary : colors.secondaryText }]}>
                  Compare
                </Text>
              </TouchableOpacity>

              {compareMode && (
                <Text style={[styles.compareHintText, { color: colors.secondaryText }]} numberOfLines={1}>
                  {compareSelection.length === 0 ? 'Tap one to compare' : 'Tap one more to compare'}
                </Text>
              )}
            </View>

            {deletedSwitchControl}
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
          // While Compare mode is on, a tap selects/deselects this item
          // instead of opening its detail view (see
          // handleToggleCompareSelection above) - `selected` drives the
          // colored-border highlight each row/tile component now
          // supports for exactly this.
          const isCompareSelected = compareMode && compareSelection.includes(item.nonce);
          const handleRowPress = compareMode
            ? () => handleToggleCompareSelection(item.nonce)
            : () => setSelectedNonce(item.nonce);
          if (viewMode === 'tiles') {
            return <NftTile nft={item} onPress={handleRowPress} columns={tileColumns} selected={isCompareSelected} />;
          }
          const SummaryRow = SUMMARY_ROW_COMPONENTS[kind];
          return SummaryRow ? (
            <SummaryRow nft={item} onPress={handleRowPress} selected={isCompareSelected} />
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
          // Extra room at the TOP only while the floating "Filters ✕"
          // button is showing, so the first row of the list starts
          // below it instead of sitting hidden behind it (the button's
          // own name-tag-chip-sized corner was covering the first
          // card's own name-tag chip before this was added - the
          // mirror image of the bottom-clearance padding this button
          // used to need back when it floated at the bottom instead).
          hasAppliedFilters && styles.listContentClearFloatingButton,
        ]}
      />

      {/* Floats over the list rather than living inline in toggleRow
          above (where it used to sit, pushing the count/Deleted switch
          onto their own extra row whenever a filter was applied) - per
          feedback that the row appearing/disappearing broke the
          toolbar's now-more-consistent look. Used to float bottom-
          center instead - moved up to float top-right, roughly under
          the Deleted pill, per later feedback, since that reads more
          like "undo the thing you just saw at the top of this screen"
          than a bottom-center button did. `right` (rather than a
          computed `left`) is what anchors it horizontally now - an
          earlier version computed `left` from a guessed button width
          (FLOATING_BUTTON_WIDTH_ESTIMATE), which left a visible gap
          between the button and the screen's right edge once the
          actual rendered width turned out narrower than the guess (see
          a screenshot's own feedback); `right` instead hugs the true
          edge exactly, no matter how wide the button actually renders,
          the same way it would with plain (non-dragged) CSS - the
          estimate is only still used for how far the drag can go (see
          clampFloatingOffset above). `top` needs no such trick, since
          the button's height IS set explicitly (floatingRemoveButton's
          own height), unlike its width.
          {...floatingButtonPanResponder.panHandlers} goes on this
          OUTER wrap rather than directly on the TouchableOpacity below
          it, so the PanResponder and the TouchableOpacity are two
          separate views layered on top of each other rather than
          fighting over the same one - see the PanResponder's own
          comment above for how a tap still reaches the TouchableOpacity
          normally. Shadow/elevation match the app's existing card-
          shadow recipe (see e.g. DevikinSummaryRow.js), just bumped up
          a little here so this reads as floating above the list rather
          than sitting flush on it. */}
      {hasAppliedFilters && (
        <View
          {...floatingButtonPanResponder.panHandlers}
          style={[
            styles.floatingRemoveWrap,
            {
              right: FLOATING_BUTTON_RIGHT_DEFAULT - floatingOffset.x,
              top: FLOATING_BUTTON_TOP_DEFAULT + floatingOffset.y,
            },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.floatingRemoveButton,
              { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: colors.cardShadow },
            ]}
            onPress={handleRemovePress}
          >
            <Text style={[styles.floatingRemoveButtonText, { color: colors.cancelText }]}>Filters ✕</Text>
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
  // occasions it rendered. Now that the Deleted switch never moves to
  // a second row anymore (see deletedSwitchControl's own comment
  // above) and "Filters ✕" floats at the bottom of the screen instead
  // of living in this row, this is simply the row's own top AND bottom
  // padding, always - no more conditional toggleRowLast variant
  // needed.
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
  },
  // Groups the List and Tiles buttons together with a small gap, so
  // the pair reads as one control (like Apple's segmented controls)
  // rather than two unrelated buttons that happen to sit next to each
  // other - same idea as deletedSwitchGroup's gap below, just applied
  // to two whole buttons instead of a label+Switch.
  viewModeButtonGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Turned into a real button (background, border, generous padding)
  // rather than bare colored text, per feedback from an Android
  // touch-target audit - this and the floating "Filters ✕" button
  // further down were the two smallest tap targets in the whole app
  // (no padding at all, just the text itself), so they got the biggest
  // bump. Originally the "Show/Hide filters" button specifically
  // (hence the name) - now reused for List and Tiles, which took over
  // this same anchor spot once Filters moved up to App.js's row
  // instead. Kept the generic name since it just describes the SLOT
  // (this row's left-anchoring button(s)), not any longer tied to
  // which control sits in it.
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
  // Compare mode's progress hint, sitting right next to the Compare
  // button inside viewModeButtonGroup (see its own JSX comment) rather
  // than as a bordered pill like the buttons beside it - plain text
  // reads as a status message, not another tappable control.
  compareHintText: {
    fontSize: 12,
    fontWeight: '600',
  },
  // height/borderWidth/borderRadius/paddingHorizontal give this the
  // same button treatment as anchorToggleButton above (List/Tiles/
  // Compare), per feedback wanting every control in this row to look
  // consistent - flexDirection/alignItems/gap are what actually lay
  // out the label next to the Switch inside that box. (This used to
  // sit alongside a matching countPill for the item count text, before
  // that moved up into App.js's own menuRow - see this file's top
  // comment and deletedSwitchControl's own comment above.)
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
  // Positions the floating "Filters ✕" button with plain left/top
  // (rather than a centering left/right: 0 technique), since it needs
  // to be draggable in both directions rather than pinned to center -
  // both are set inline per render (see the JSX), since they depend on
  // windowWidth and the button's current drag offset.
  floatingRemoveWrap: {
    position: 'absolute',
  },
  // A bit bigger than the rest of the row's buttons (height 40 -> 50,
  // fontSize ~13 -> 17, see floatingRemoveButtonText below) per
  // feedback, now that it's a standalone control rather than one more
  // button sitting in that row - big enough to read clearly and stay
  // easy to tap on its own, without dominating the screen (an earlier
  // +50% pass, height 60, read as too big once seen on-device - this
  // settled at +25% instead). height matches FLOATING_BUTTON_HEIGHT
  // above, which the drag-clamping math also uses, so the two can't
  // drift apart. Shadow/elevation are the same recipe the app's cards
  // already use (see e.g. DevikinSummaryRow.js's own `row` style), just
  // bumped up a little further here so this reads as floating above
  // the list rather than a button that just happens to sit on top of
  // it - shadowColor comes from the theme inline (see the JSX), the
  // rest is fixed here.
  floatingRemoveButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 13,
    height: FLOATING_BUTTON_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  floatingRemoveButtonText: {
    fontWeight: '600',
    fontSize: 17,
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
  // Applied on top of listContent above (not instead of - see the
  // FlatList's own contentContainerStyle) only while the floating
  // "Filters ✕" button is showing, so the first row of the list
  // starts clear of it instead of sitting partly hidden underneath it.
  // This is EXTRA padding on top of where the list already starts
  // (right below the toolbar/filterBar) - a first pass added
  // FLOATING_BUTTON_TOP_DEFAULT to this number too, which double-
  // counted the toolbar's own height (TOP_DEFAULT is measured from the
  // very top of the screen, the same origin the toolbar itself starts
  // from, not from where the list already begins) and left a much
  // bigger gap above the first row than intended - fixed per a
  // screenshot showing that gap. FLOATING_BUTTON_HEIGHT alone,
  // plus a little breathing room, is enough: the toolbar's own height
  // already accounts for most of the button's vertical offset, since
  // TOP_DEFAULT only nudges the button a few px below where the
  // toolbar (and so the list) already ends.
  listContentClearFloatingButton: {
    paddingTop: FLOATING_BUTTON_HEIGHT + 20,
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
