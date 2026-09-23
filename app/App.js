/**
 * App.js
 *
 * The root of the whole app. This is the file Expo runs first. It's
 * responsible for:
 *
 *   - Wrapping everything in a ThemeProvider, so light/dark mode is
 *     available to every screen (see src/context/ThemeContext.js).
 *   - Setting up the local database once, when the app starts.
 *   - Rendering the persistent top bar shown above the Devikins/
 *     Weapons/Equipment screens: a top row with the ☰ hamburger button
 *     on the left (opens HamburgerMenu.js, a full-screen menu that
 *     replaced the old tab bar and the old Fetch/Update + Wallets
 *     buttons that used to sit at the top of the screen) and the
 *     light/dark theme toggle on the right, then the search field on
 *     its own row underneath. The exact-match star-rating filter
 *     (StarRating.js) that
 *     used to live in this top bar now lives inside each collection's
 *     own Filters panel instead (FilterPanel.js), alongside the other
 *     trait filters. See HamburgerMenu.js's own file
 *     comment for the six menu entries and what each one does.
 *   - Kicking off fetchAllForWallets.js when Fetch/Update is tapped (now
 *     from inside the menu), and tracking its progress/cancellation.
 *     This is the ONLY way a fetch ever runs - there's no automatic
 *     background fetching/retrying of any kind; nothing happens over
 *     the network unless you tap Fetch/Update yourself.
 *   - Deciding which "screen" is currently showing: one of the three
 *     collection kinds (devikin/weapon/equipment), the Wallets
 *     management screen, or the Feedback form - see `currentScreen`
 *     below.
 *
 * Deliberately NOT using a navigation library (like React Navigation) -
 * everything here is just plain React state (useState) deciding what to
 * render. For an app this size, that's simpler to follow than adding a
 * whole navigation system on top. `currentScreen` plays the same role a
 * router's "current route" would.
 *
 * V2 note: TabBar.js (the old Devikins/Weapons/Equipment tab row) is no
 * longer used - switching between those three is now done from inside
 * HamburgerMenu.js instead, per the V2 navigation redesign. The file is
 * left in place rather than deleted, in case you'd ever want the old
 * tab-row look back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  BackHandler,
  Platform,
  ToastAndroid,
  AppState,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { initDatabase, getWallets, getSetting, setSetting, countPendingRetries } from './src/db/database';
import { fetchAllForWallets, retryPendingItemsForWallets, checkImageFreshnessForWallets } from './src/api/fetchAllForWallet';
import { COLLECTIONS, getSortableFieldNames } from './src/constants/schema';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import HamburgerMenu from './src/components/HamburgerMenu';
import CollectionView from './src/components/CollectionView';
import ProgressBar from './src/components/ProgressBar';
import WalletManager from './src/components/WalletManager';
import Feedback from './src/components/Feedback';
import HelpAssistant from './src/components/HelpAssistant';
import SortPickerModal from './src/components/SortPickerModal';
import { humanizeColumnName } from './src/components/FilterPanel';
import appConfig from './app.json';

// The app's version number, shown small on the loading screen - pulled
// straight from app.json rather than duplicated here, so it can never
// drift out of sync with the number EAS Build actually uses when
// producing a real APK (eas.json's "appVersionSource": "local" means
// app.json's version field IS the source of truth for that too). Also
// used by Feedback.js, so the app name/version are always sent along
// with a feedback email without that file needing its own copy.
const APP_VERSION = appConfig.expo.version;

// The default export wraps everything in SafeAreaProvider (needed by the
// react-native-safe-area-context package so any SafeAreaView/useSafeArea
// call below it knows about the phone's notch/status bar/home indicator)
// and ThemeProvider (light/dark mode) - all the actual app logic lives in
// AppContent below, so that AppContent can call useTheme() (a component
// can't use its own provider's context, hence the split into two
// components).
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const { colors, isDark, toggleTheme } = useTheme();
  // The actual, device-reported height of whatever system UI sits along
  // the bottom edge (the Android navigation bar - 3-button or gesture
  // pill - or the iOS home indicator). Needed for the version number on
  // the splash screen below: SafeAreaView's own automatic edge padding
  // was still letting the Android nav bar cover it on Raphael's phone,
  // so that one element reads this directly and adds its own clearance
  // on top, rather than trusting SafeAreaView alone to have already
  // accounted for it.
  const insets = useSafeAreaInsets();

  // Whether the local database has finished its one-time setup. We don't
  // show the rest of the app until this is true, so nothing tries to
  // query a database that doesn't have its tables yet.
  const [isDatabaseReady, setIsDatabaseReady] = useState(false);

  // How long to keep the "Devikins Legacy" loading screen on screen at
  // minimum, in milliseconds. The database itself sets up almost
  // instantly (well under a second), so without this the loading screen
  // would flash by too quickly to read - this holds it for a fixed
  // 3 seconds instead, per feedback to shorten it.
  const MIN_SPLASH_DURATION_MS = 3000;

  // How long a second Back press (see the BackHandler effect below) has
  // to land in, after the first one, to actually exit the app instead
  // of just re-arming the "press again" toast.
  const EXIT_CONFIRM_WINDOW_MS = 2000;

  // How often to check for anything left unfinished (failed items,
  // missing images) and quietly retry it in the background, how many
  // times in a row to try at that fast pace, and how long to wait between
  // attempts after that fast pace is used up. At one retry round per
  // minute, 10 rounds is about 10 minutes of fast automatic retrying -
  // generous enough to ride out a temporary hiccup in the metadata
  // Lambda (see NOTES.md) without the user doing anything, but if
  // something's still broken after 10 minutes straight, a longer-lived
  // problem (the item genuinely doesn't exist, say) is more likely, and
  // there's no point hammering it every minute forever. Tapping
  // Fetch/Update manually always resets straight back to the fast pace.
  // Re-added per feedback, after being removed for a while (see NOTES.md
  // - "Automatic background retry removed") - only runs while the app is
  // open, same as before; nothing registers a real background task.
  const AUTO_RETRY_INTERVAL_MS = 60000;
  const MAX_AUTO_RETRY_ROUNDS = 10;
  const SLOW_RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // How often the SEPARATE image-freshness check (did Moonlabs correct
  // an already-downloaded picture?) is allowed to run - see
  // checkImageFreshnessForWallets in fetchAllForWallet.js. This shares
  // the same once-a-minute timer as the retry rounds above, but has its
  // own plain hourly cadence, independent of whatever pace the retry
  // rounds are currently at - a rare, low-urgency event like this
  // doesn't need a fast burst the way a broken fetch does.
  const IMAGE_FRESHNESS_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // The full list of saved wallets (each { id, address, created_at }),
  // loaded from the database (see WalletManager.js for how they're
  // added/edited/removed) and kept in sync here via loadWallets below.
  // `walletAddresses` is just the plain address strings, which is all
  // CollectionView/the fetch functions actually need.
  const [wallets, setWallets] = useState([]);
  // Memoized so this array only gets a new identity when `wallets`
  // itself actually changes (add/edit/delete a wallet) - NOT on every
  // render of App.js. That matters a lot during a fetch: `setProgress`
  // fires very often as items come in, and without this, each of those
  // re-renders would have handed CollectionView a brand-new
  // `ownerAddresses` array (same contents, different reference), which
  // its effects treat as "the data changed, reload everything" - causing
  // the list to flicker and jump back to the top on every single
  // progress tick instead of just once when a collection finishes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const walletAddresses = useMemo(() => wallets.map((wallet) => wallet.address), [wallets]);

  // Which "screen" is currently showing - one of the three collection
  // kinds (devikin/weapon/equipment), 'wallets', or 'feedback'. This
  // replaced the old pair of separate flags (activeKind + a
  // showWalletManager boolean) now that a fourth, non-collection screen
  // (Feedback) exists too - one variable naming exactly one current
  // screen is simpler to reason about than several booleans that could
  // theoretically all be true/false in an invalid combination.
  const [currentScreen, setCurrentScreen] = useState(Object.keys(COLLECTIONS)[0]);

  // Remembers whichever collection screen (devikin/weapon/equipment) was
  // showing right before Wallets or Feedback was opened, so their own
  // "‹ Back to Home" buttons (and Android's Back button/gesture - see
  // the BackHandler effect below) return to that same tab instead of
  // always landing back on Devikins.
  const [lastCollectionScreen, setLastCollectionScreen] = useState(Object.keys(COLLECTIONS)[0]);

  // Switches which screen is showing, and - only for an actual
  // collection kind - remembers it as the "last collection screen" for
  // Wallets/Feedback's Back button to return to. Wallets and Feedback
  // themselves are never remembered as a "last collection screen" (that
  // wouldn't make sense - there'd be nothing to switch "back" to).
  const goToScreen = useCallback((screen) => {
    setCurrentScreen(screen);
    if (COLLECTIONS[screen]) {
      setLastCollectionScreen(screen);
    }
  }, []);

  // Whether the full-screen hamburger menu (HamburgerMenu.js) is
  // currently open.
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // The top search bar's current text (search by NFT name/custom name
  // or ID/nonce - see queryNfts in database.js) and the exact-match
  // star-rating filter's applied value (0 = no rating filter, 1-5 =
  // show only that exact rating) - both live here rather than inside
  // CollectionView because, unlike the per-collection trait filters
  // CollectionView already manages, an applied search/star pick is
  // meant to carry over as you switch between Devikins/Weapons/
  // Equipment (searching "123" and then checking another tab for the
  // same search is the expected behavior, not a bug - see
  // CollectionView.js's own filter-reset effect, which resets its own
  // local `pendingStarFilter` back to whatever's still applied here on
  // a tab switch, but never touches searchText or this starFilter
  // itself). The star filter's own control used to sit up here too,
  // next to the search field; it's now rendered inside FilterPanel.js
  // instead (see CollectionView.js, which passes starFilter/
  // setStarFilter down that far as onStarFilterChange). Unlike
  // searchText, which updates this state directly on every keystroke,
  // `setStarFilter` (passed down as `onStarFilterChange`) is now only
  // called once Apply Filters (or Remove filters) is pressed in
  // CollectionView.js - per feedback that a star narrowing the list the
  // instant it was tapped, while every other filter waited for Apply,
  // was confusing. See CollectionView.js's own file comment for the
  // full reasoning.
  const [searchText, setSearchText] = useState('');
  const [starFilter, setStarFilter] = useState(0);

  // List vs. Tiles - ONE shared choice across Devikins/Weapons/Equipment
  // (picking Tiles on one tab shows Tiles on the others too, per
  // feedback that per-tab was more confusing than useful), remembered
  // across app restarts via the generic settings table in database.js
  // (the same one theme/wallet-migration state already uses). Lives
  // here rather than in CollectionView.js, per feedback moving its own
  // toggle up onto this top search row (on the right, next to the
  // search field) - CollectionView.js just receives the current value
  // as a plain `viewMode` prop now, it doesn't own this state itself
  // any more. Starts as 'list' until the saved setting (if any) loads,
  // and is loaded once here on mount - not per collection/tab - since
  // it's one shared value, not a per-kind one.
  const [viewMode, setViewMode] = useState('list');

  useEffect(() => {
    let cancelled = false;
    async function loadViewMode() {
      const saved = await getSetting('viewMode');
      if (!cancelled && (saved === 'list' || saved === 'tiles')) {
        setViewMode(saved);
      }
    }
    loadViewMode();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSetViewMode(nextMode) {
    setViewMode(nextMode);
    setSetting('viewMode', nextMode);
  }

  // V3: which field the current collection is sorted by, and which
  // direction - unlike viewMode above, this is deliberately NOT one
  // shared value across all three tabs, since most fields (a Devikin's
  // Overall Affinity, say) only exist on one kind. It's also
  // deliberately NOT reset back to the default on every tab switch
  // either, the way CollectionView.js's own trait filters are (see its
  // kind-change effect) - a few fields (`nonce`/ID, `first_seen`, and
  // `rarity`) exist identically on all three collections, so "sort by
  // Rarity" carrying over from Devikins to Weapons is actually useful,
  // not stale leftover state. The clamp effect just below only steps in
  // when the CURRENT field genuinely doesn't exist on the tab just
  // switched to - e.g. leaving Devikins' Overall Affinity sort and
  // landing on Weapons, which has no such field.
  const [sortField, setSortField] = useState('nonce');
  const [sortDirection, setSortDirection] = useState('asc');
  const [isSortPickerVisible, setIsSortPickerVisible] = useState(false);

  useEffect(() => {
    if (!COLLECTIONS[currentScreen]) return; // not a collection tab (wallets/feedback/help) - nothing to clamp
    if (!getSortableFieldNames(currentScreen).includes(sortField)) {
      setSortField('nonce');
      setSortDirection('asc');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScreen]);

  // The Sort picker's field list, scoped to whichever collection is
  // currently showing (see getSortableFieldNames in schema.js) - 'nonce'
  // and 'first_seen' get their own plain-English labels since they
  // aren't real traits, everything else reuses FilterPanel.js's own
  // humanizeColumnName so a trait reads the same way here as it does in
  // the Filters panel.
  const sortFieldOptions = useMemo(() => {
    if (!COLLECTIONS[currentScreen]) return [];
    return getSortableFieldNames(currentScreen).map((name) => ({
      name,
      label: name === 'nonce' ? 'ID' : name === 'first_seen' ? 'Recently Added' : humanizeColumnName(name),
    }));
  }, [currentScreen]);

  // Tapping a field that's already the active one flips its direction
  // instead of re-picking the same field pointlessly - tapping a
  // different field picks it fresh, defaulting to descending (highest/
  // "best" first reads more usefully for a stat or Rarity than
  // alphabetical-first would) except for ID, which defaults ascending
  // to match the app's own original, pre-Sort-feature default order.
  function handleSelectSortField(fieldName) {
    if (fieldName === sortField) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(fieldName);
      setSortDirection(fieldName === 'nonce' ? 'asc' : 'desc');
    }
  }

  // Progress info from fetchAllForWallets.js's onProgress callback, and
  // whether a fetch is currently running at all.
  const [progress, setProgress] = useState(null);
  const [isFetching, setIsFetching] = useState(false);
  // True from the moment "Stop" is tapped until the fetch/retry it
  // stopped actually finishes winding down - purely cosmetic (see
  // ProgressBar.js), so the Stop button gives some immediate
  // acknowledgement rather than looking like the tap did nothing while
  // the in-flight request it's interrupting finishes aborting.
  const [isCancelling, setIsCancelling] = useState(false);

  // Bumping this number tells CollectionView/FilterPanel "something in
  // the database may have changed, please reload".
  const [refreshKey, setRefreshKey] = useState(0);

  // True while a manual fetch is in flight - kept as a ref (rather than
  // just relying on `isFetching`) so handleFetchPress can check "is one
  // already running?" synchronously at the very top of itself, before
  // any state update has had a chance to re-render.
  const busyRef = useRef(false);

  // A plain mutable ref (not React state) that the in-progress fetch
  // checks between steps to know whether the user asked it to stop. It's
  // a ref rather than state because setting it doesn't need to cause a
  // re-render by itself - only the Stop button's own UI needs updating,
  // and that happens through isFetching/progress instead.
  const cancelRequestedRef = useRef(false);

  // Whether the background auto-retry timer is currently running a round
  // (either a pending-items retry or an image-freshness check - see the
  // timer effect below), and what it's up to - shown via the same
  // ProgressBar component the manual Fetch uses, so it looks consistent.
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryProgress, setRetryProgress] = useState(null);

  // How many automatic retry rounds have run in a row since the last
  // manual Fetch, so we know when to switch from the fast (once a
  // minute) pace to the slow (once an hour) one.
  const retryRoundRef = useRef(0);

  // The earliest time (a Date.now() timestamp in milliseconds) the next
  // automatic retry attempt is allowed to run. Starts at 0, meaning "no
  // wait, try as soon as there's something pending" - this is what lets
  // one single timer (ticking every AUTO_RETRY_INTERVAL_MS) serve both
  // the fast and slow paces, just by skipping ticks until this time is
  // reached, rather than needing a second, separate timer for the hourly
  // pace.
  const nextRetryAtRef = useRef(0);

  // Same idea as nextRetryAtRef above, but for the separate image-
  // freshness check - its own independent "not before this time" gate,
  // since it runs on a plain hourly cadence regardless of whatever pace
  // the pending-items retry above is currently at.
  const nextFreshnessCheckAtRef = useRef(0);

  // Timestamp (Date.now()) of the last Back press that reached the
  // "genuinely nothing left to close" fallback below - i.e. you're on a
  // collection screen's list view, with no detail view open and the
  // hamburger menu closed. Powers the "press Back again to exit" double-
  // tap confirmation just below, instead of a single accidental Back
  // press quitting the app outright.
  const lastExitBackPressAtRef = useRef(0);

  // Reloads the wallet list from the database - called once on startup,
  // and again every time WalletManager.js adds/edits/removes one, so this
  // component always has the current list.
  const loadWallets = useCallback(async () => {
    const rows = await getWallets();
    setWallets(rows);
  }, []);

  useEffect(() => {
    // Run the real database setup and a plain timer side by side, and
    // wait for BOTH to finish before dismissing the loading screen -
    // this is what makes the loading screen last a fixed minimum amount
    // of time even though the database itself is ready almost instantly.
    // (If the database ever took longer than MIN_SPLASH_DURATION_MS on a
    // slow phone, this still works correctly - Promise.all waits for
    // whichever of the two takes longer, it never cuts the database
    // setup short.)
    const minSplashDelay = new Promise((resolve) => setTimeout(resolve, MIN_SPLASH_DURATION_MS));

    Promise.all([initDatabase(), minSplashDelay]).then(async () => {
      // Load whatever wallets are already saved (including the one
      // automatically carried over from before this multi-wallet feature
      // existed - see initDatabase's migration in database.js) and show
      // their already-saved NFTs right away - no need to wait on the
      // network just to see data we already have. Tapping Fetch/Update
      // still checks for anything new/changed, same as always.
      await loadWallets();
      setIsDatabaseReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Makes Android's system Back button/gesture close whatever's
  // currently "on top" instead of exiting the app straight away, in this
  // priority order:
  //   1. If the hamburger menu is open, close just the menu.
  //   2. Else, if Wallets, Feedback, or Devi (Help) is showing, go back
  //      to whichever collection screen (devikin/weapon/equipment) was
  //      showing before it was opened.
  //   3. Otherwise, step aside (return false) and let CollectionView.js's
  //      OWN matching listener take its own shot first - it closes an
  //      open NFT detail view if one's open, and its listener always
  //      runs before this one (React Native calls the most-recently-
  //      registered `hardwareBackPress` listener first, and CollectionView
  //      is mounted further down the tree - see its own file comment).
  //   4. If NEITHER of the above had anything to close, this really is
  //      "nothing left, Android wants to exit the app" - rather than
  //      quitting on a single accidental Back press, this requires a
  //      second press within EXIT_CONFIRM_WINDOW_MS, showing a brief
  //      "Press back again to exit" toast in between (the standard
  //      Android pattern for exactly this situation).
  // The listeners never conflict, since CollectionView isn't even
  // mounted while Wallets/Feedback/Devi is showing (see the render logic
  // below).
  useEffect(() => {
    function handleBackPress() {
      if (isMenuOpen) {
        setIsMenuOpen(false);
        return true; // handled - don't also exit the app
      }
      if (currentScreen === 'wallets' || currentScreen === 'feedback' || currentScreen === 'help') {
        goToScreen(lastCollectionScreen);
        return true; // handled - don't also exit the app
      }
      // CollectionView.js's OWN BackHandler listener (registered further
      // down the component tree) always gets first chance at a Back
      // press - see its file comment. By the time execution reaches
      // here, that already means there's no open NFT detail view to
      // close either, so this really is "nothing left to close, Android
      // wants to exit the app" - the exact moment a single accidental
      // Back press used to just quit outright. Instead, require a
      // second Back press within EXIT_CONFIRM_WINDOW_MS, with a toast
      // in between - the standard Android "press back again to exit"
      // pattern, so one stray tap on the home screen doesn't close the
      // app on you.
      const now = Date.now();
      if (now - lastExitBackPressAtRef.current < EXIT_CONFIRM_WINDOW_MS) {
        return false; // second press in time - let Android actually exit
      }
      lastExitBackPressAtRef.current = now;
      if (Platform.OS === 'android') {
        ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
      }
      return true; // swallow this first press
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [isMenuOpen, currentScreen, lastCollectionScreen, goToScreen]);

  const handleFetchPress = useCallback(async () => {
    if (walletAddresses.length === 0 || busyRef.current) return;

    cancelRequestedRef.current = false;
    busyRef.current = true;
    // A fresh manual fetch always gets a full new budget of automatic
    // retry rounds afterward, even if the previous ones had run out (and
    // switches back to the fast once-a-minute pace, even if it had
    // backed off to the slow hourly one). Deliberately does NOT touch
    // nextFreshnessCheckAtRef - the image-freshness check runs on its
    // own plain hourly cadence regardless of manual fetches (a normal
    // Fetch/Update doesn't re-verify an already-cached image against the
    // remote host at all, so there's no reason a manual fetch should
    // reset or hurry that check along).
    retryRoundRef.current = 0;
    nextRetryAtRef.current = 0;
    setIsFetching(true);
    setProgress({ phase: 'listing', label: 'your wallet' });

    try {
      await fetchAllForWallets(walletAddresses, {
        onProgress: (nextProgress) => {
          setProgress(nextProgress);

          // As soon as one collection finishes fetching, refresh the
          // screen so its data shows up right away - the user doesn't
          // have to wait for ALL three collections (let alone every
          // wallet) before seeing anything.
          const justFinishedACollection =
            nextProgress.phase === 'fetching' &&
            nextProgress.total > 0 &&
            nextProgress.completed === nextProgress.total;
          if (justFinishedACollection) {
            setRefreshKey((key) => key + 1);
          }
        },
        shouldCancel: () => cancelRequestedRef.current,
      });
    } catch (err) {
      setProgress({ phase: 'error', label: 'this wallet', error: err.message });
    } finally {
      busyRef.current = false;
      setIsFetching(false);
      setIsCancelling(false);
      setRefreshKey((key) => key + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets]);

  function handleCancelPress() {
    cancelRequestedRef.current = true;
    setIsCancelling(true);
  }

  // The three things HamburgerMenu.js's entries can do - see its own
  // file comment for the full list of six entries. All three close the
  // menu first; picking a screen also updates `lastCollectionScreen` via
  // goToScreen when it's an actual collection kind.
  function handleMenuSelectScreen(screen) {
    setIsMenuOpen(false);
    goToScreen(screen);
  }

  function handleMenuSelectFetch() {
    setIsMenuOpen(false);
    handleFetchPress();
  }

  // The automatic background maintenance timer: every AUTO_RETRY_INTERVAL_MS
  // (once a minute), if nothing else is currently fetching, does up to
  // two independent things:
  //
  //   1. Pending-items retry: checks whether any saved wallet has
  //      anything left unfinished (failed items, or items missing a
  //      cached image) and quietly retries just those - see
  //      retryPendingItemsForWallets in fetchAllForWallet.js. Fast (once
  //      a minute) for the first MAX_AUTO_RETRY_ROUNDS rounds after
  //      anything triggers it, then backs off to slow (once an hour) -
  //      see the AUTO_RETRY_INTERVAL_MS/MAX_AUTO_RETRY_ROUNDS/
  //      SLOW_RETRY_INTERVAL_MS comment above for the reasoning. This is
  //      what fixes "some items stayed failed/imageless after the last
  //      Fetch" without the user having to keep tapping Fetch by hand.
  //      Per feedback, this same check also runs immediately (not just
  //      on the timer's own pace) right when the app opens and every
  //      time it comes back to the foreground - see the AppState
  //      listener below - so anything left over is already being fixed
  //      by the time you're looking at the screen, not just eventually.
  //      The check itself (countPendingRetries) is a cheap local
  //      database read, so triggering it often costs nothing extra when
  //      there's nothing actually wrong - it only escalates to real
  //      network requests when there's something to retry.
  //
  //   2. Image-freshness check: on its own separate, plain hourly
  //      cadence (nextFreshnessCheckAtRef/IMAGE_FRESHNESS_CHECK_INTERVAL_MS,
  //      independent of whatever pace #1 is currently at), asks whether
  //      Moonlabs has corrected any already-downloaded picture - see
  //      checkImageFreshnessForWallets in fetchAllForWallet.js. This one
  //      stays purely on its own hourly timer (not triggered by opening
  //      the app) - it's a rare, low-urgency event, not something that
  //      needs catching up on the moment you look at the screen.
  //
  // Both share the same busyRef/isRetrying/retryProgress machinery and
  // run one at a time, never concurrently with each other or with a
  // manual fetch - see busyRef's own comment above.
  useEffect(() => {
    if (walletAddresses.length === 0) return undefined;

    retryRoundRef.current = 0;
    nextRetryAtRef.current = 0;
    nextFreshnessCheckAtRef.current = 0;

    // The pending-items retry itself (part 1 above), pulled out into its
    // own function so both the once-a-minute timer below AND the
    // immediate/foreground triggers further down can share the exact
    // same logic, rather than the timer being the only thing that ever
    // runs it.
    async function runPendingRetryPass() {
      if (busyRef.current) return;

      const pending = await countPendingRetries(walletAddresses);

      if (pending.total === 0) {
        // Fully caught up - reset both the round count and the pace,
        // so a future problem gets a full fast burst of retry
        // attempts again rather than starting from wherever the pace
        // last left off.
        retryRoundRef.current = 0;
        nextRetryAtRef.current = 0;
        return;
      }

      retryRoundRef.current += 1;
      busyRef.current = true;
      cancelRequestedRef.current = false;
      setIsRetrying(true);

      // Say up front what KIND of work this round is about to do -
      // a full NFT refetch (metadata never came through) is a
      // different, slower thing than just retrying an image, so
      // it's worth being specific rather than a generic "N item(s)"
      // count.
      const summaryParts = [];
      if (pending.failedCount > 0) {
        summaryParts.push(`${pending.failedCount} NFT refetch${pending.failedCount === 1 ? '' : 'es'}`);
      }
      if (pending.missingImageCount > 0) {
        summaryParts.push(`${pending.missingImageCount} image refetch${pending.missingImageCount === 1 ? '' : 'es'}`);
      }
      setRetryProgress({ phase: 'summary', label: `Retrying: ${summaryParts.join(' and ')}` });

      try {
        await retryPendingItemsForWallets(walletAddresses, {
          onProgress: setRetryProgress,
          shouldCancel: () => cancelRequestedRef.current,
        });
      } finally {
        busyRef.current = false;
        setIsRetrying(false);
        setIsCancelling(false);
        setRetryProgress(null);
        setRefreshKey((key) => key + 1);

        // Once the fast burst is used up, don't check again for
        // another hour instead of giving up for good - see the
        // constants' comment above for why. This re-applies every
        // hourly round too (not just the first time), so it keeps
        // retrying once an hour indefinitely rather than only
        // backing off once.
        if (retryRoundRef.current >= MAX_AUTO_RETRY_ROUNDS) {
          nextRetryAtRef.current = Date.now() + SLOW_RETRY_INTERVAL_MS;
        }
      }
    }

    // Run once right away - covers a fresh app launch, and this effect
    // re-running because the wallet list itself just changed - rather
    // than leaving anything unfinished sitting there until the timer's
    // own first tick (up to AUTO_RETRY_INTERVAL_MS later).
    runPendingRetryPass();

    // Per feedback, also run every time the app comes back to the
    // foreground, not just on a cold launch - e.g. switching back after
    // checking a message elsewhere. AppState's 'change' event fires for
    // every transition (including the brief 'inactive' state iOS uses
    // while switching), so only a transition TO 'active' is acted on.
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        runPendingRetryPass();
      }
    });

    const intervalId = setInterval(async () => {
      if (busyRef.current) return;

      // Part 1: the fast/slow-paced pending-items retry (see
      // runPendingRetryPass above - the exact same function the
      // immediate/foreground triggers use).
      if (Date.now() >= nextRetryAtRef.current) {
        await runPendingRetryPass();
      }

      // Part 2: the separate, plain-hourly image-freshness check - only
      // runs if part 1 above didn't just leave something mid-flight
      // (busyRef check repeated here since part 1 may have just finished
      // synchronously above).
      if (!busyRef.current && Date.now() >= nextFreshnessCheckAtRef.current) {
        busyRef.current = true;
        cancelRequestedRef.current = false;
        setIsRetrying(true);
        setRetryProgress({ phase: 'summary', label: 'Checking cached images for updates' });

        try {
          await checkImageFreshnessForWallets(walletAddresses, {
            onProgress: setRetryProgress,
            shouldCancel: () => cancelRequestedRef.current,
          });
        } finally {
          busyRef.current = false;
          setIsRetrying(false);
          setIsCancelling(false);
          setRetryProgress(null);
          setRefreshKey((key) => key + 1);
          nextFreshnessCheckAtRef.current = Date.now() + IMAGE_FRESHNESS_CHECK_INTERVAL_MS;
        }
      }
    }, AUTO_RETRY_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      appStateSubscription.remove();
    };
    // Re-runs whenever the actual set of wallet addresses changes (not on
    // every unrelated re-render) - comparing the joined string is a
    // simple, reliable way to depend on "the addresses themselves changed"
    // rather than "the wallets array is a new reference".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddresses.join(',')]);

  // react-native-safe-area-context's SafeAreaView (imported above)
  // correctly reserves space for the status bar / notch / Dynamic Island
  // on BOTH iOS and Android on its own - unlike the old SafeAreaView from
  // 'react-native' (which Expo now warns is deprecated), so there's no
  // manual Android-only padding calculation needed here any more. The
  // extra breathing room in topBar below is still there on top of that,
  // since that was about visual spacing, not safe-area correctness.
  // A simple splash/loading screen, shown only for the brief moment while
  // the local database is doing its one-time setup when the app first
  // opens (see the useEffect above that calls initDatabase()). "Devikins"
  // and "Legacy" are two separate Text elements (not one string with a
  // line break in it) so each line can be styled and centered the same
  // way regardless of screen width. "Companion" sits underneath as a
  // smaller tagline rather than a third full-size title line - it's part
  // of the app's name, but doesn't need equal visual weight.
  // The version number is pinned to the bottom of the screen with
  // position: 'absolute' (see splashVersion) rather than just being
  // another line in this centered group - "at the bottom of the screen"
  // means the very bottom, not just below the other centered text.
  if (!isDatabaseReady) {
    return (
      <SafeAreaView style={[styles.centeredContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.splashTitleLine, { color: colors.primary }]}>Devikins</Text>
        <Text style={[styles.splashTitleLine, { color: colors.primary }]}>Legacy</Text>
        <Text style={[styles.splashTagline, { color: colors.primary }]}>Companion</Text>
        <Text style={[styles.splashSubtitle, { color: colors.secondaryText }]}>Setting up local database...</Text>
        <View style={[styles.splashVersionWrap, { bottom: insets.bottom + 16 }]}>
          <Text style={[styles.splashVersion, { color: colors.secondaryText }]}>v{APP_VERSION}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // The Wallets management screen takes over the whole content area,
  // same as it always has ("the wallets screen (unchanged)") - no search
  // bar or hamburger row on top of it, just its own "‹ Back to Home"
  // button, which now returns to whichever collection screen was showing
  // before Wallets was opened (see goToScreen/lastCollectionScreen
  // above) instead of just flipping a boolean back off.
  if (currentScreen === 'wallets') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <WalletManager
          wallets={wallets}
          onWalletsChanged={loadWallets}
          onClose={() => goToScreen(lastCollectionScreen)}
        />
      </SafeAreaView>
    );
  }

  // The Feedback form is the sixth hamburger menu entry - see
  // Feedback.js's own file comment for how it builds and sends its
  // mailto: draft. Same full-screen-takeover pattern as Wallets above.
  if (currentScreen === 'feedback') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Feedback appVersion={APP_VERSION} onClose={() => goToScreen(lastCollectionScreen)} />
      </SafeAreaView>
    );
  }

  // "Devi" - the offline in-app FAQ helper, the seventh (and, per how
  // this was designed, deliberately last) hamburger menu entry - see
  // HelpAssistant.js's own file comment for the full "why" here. Same
  // full-screen-takeover pattern as Wallets/Feedback above.
  if (currentScreen === 'help') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <HelpAssistant onClose={() => goToScreen(lastCollectionScreen)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      {/* The ☰ hamburger button (opens HamburgerMenu.js - see its file
          comment for the six entries that used to be spread across the
          old Fetch/Wallets buttons and tab row) on the top-left, and the
          light/dark theme toggle on the top-right of this same row, per
          feedback - it used to share a row with the search field
          instead. This row carries the extra top padding that clears
          the status bar/notch, being the first thing on screen. The
          toggle is NOT gated on having a wallet, unlike the search
          field below - it needs to stay reachable even on a brand-new
          install with nothing added yet. */}
      <View style={styles.menuRow}>
        <TouchableOpacity
          style={[styles.hamburgerButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
          onPress={() => setIsMenuOpen(true)}
        >
          <Text style={[styles.hamburgerIcon, { color: colors.text }]}>☰</Text>
        </TouchableOpacity>

        {/* Trying this here per feedback, in place of its own full-width
            row below menuRow/searchRow - the concern being that the old
            placement felt too prominent and the app felt less responsive
            while it was up. First attempt: just relocate the same
            ProgressBar between the two buttons on this row, wrapped in a
            flex:1 View so it fills whatever space isn't taken by the
            hamburger button and theme toggle. See ProgressBar.js's own
            container style for the small adjustment that went with this
            (it used to carry its own margin, meant for being a
            standalone full-width block). */}
        {(isFetching || isRetrying) && (
          <View style={styles.inlineProgressWrapper}>
            <ProgressBar
              progress={isFetching ? progress : retryProgress}
              onCancel={handleCancelPress}
              isCancelling={isCancelling}
            />
          </View>
        )}

        <TouchableOpacity
          style={[styles.themeToggle, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
          onPress={toggleTheme}
        >
          <Text style={styles.themeToggleIcon}>{isDark ? '☀️' : '🌙'}</Text>
          <Text style={[styles.themeToggleLabel, { color: colors.text }]}>
            {isDark ? 'Light' : 'Dark'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search by NFT name/custom name or ID, plus the List/Tiles
          toggle on the right (moved up here from its own row inside
          CollectionView.js, per feedback) - both only shown once
          there's at least one wallet, with nothing fetched yet there's
          nothing to search or view either way, same reasoning the old
          tab bar/CollectionView used to decide whether to show
          themselves at all (this whole row is skipped rather than left
          empty in that case, now that the theme toggle that used to
          always keep this row non-empty has moved up onto menuRow
          above). The star-rating filter that used to sit here too has
          moved down into each collection's own Filters panel instead -
          see FilterPanel.js. */}
      {walletAddresses.length > 0 && (
        <>
        <View style={styles.searchRow}>
          <View style={styles.searchInputWrapper}>
            <TextInput
              style={[styles.searchInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
              placeholder="Search by name or ID"
              placeholderTextColor={colors.secondaryText}
              value={searchText}
              onChangeText={setSearchText}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {/* Only shown once there's actually something to clear - a
                small "✕" overlaid on the input's right edge, the usual
                mobile search-field pattern, so clearing a search doesn't
                need selecting/deleting the text by hand. */}
            {searchText.length > 0 && (
              <TouchableOpacity
                style={styles.searchClearButton}
                onPress={() => setSearchText('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.searchClearButtonText, { color: colors.secondaryText }]}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Opens SortPickerModal below - sits between the search field
              and the List/Tiles toggle, per feedback discussion (a new
              menu point + subpage felt heavier than needed for what's
              really a single small choice). Shows the active field's
              short label plus an arrow for the current direction, so the
              current sort is visible without opening the sheet. */}
          <TouchableOpacity
            style={[styles.sortButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setIsSortPickerVisible(true)}
          >
            <Text
              style={[styles.sortButtonText, { color: colors.secondaryText }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {sortDirection === 'asc' ? '↑' : '↓'} {sortFieldOptions.find((option) => option.name === sortField)?.label ?? 'ID'}
            </Text>
          </TouchableOpacity>

          {/* Used to be two separate buttons (List / Tiles, whichever
              wasn't active shown dimmed) - collapsed into one per
              feedback once the Sort button above made this row feel
              crowded, with no room to add a fourth row for it. A single
              button toggling between the two is enough since there are
              only ever two states: it shows whichever mode is CURRENTLY
              active, and tapping it switches straight to the other one -
              no need for the old side-by-side "here's your other option
              too" layout when there's only one other option to begin
              with. */}
          <TouchableOpacity
            style={[styles.viewModeButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => handleSetViewMode(viewMode === 'list' ? 'tiles' : 'list')}
          >
            <Text style={[styles.viewModeButtonText, { color: colors.secondaryText }]}>
              {viewMode === 'list' ? 'List' : 'Tiles'}
            </Text>
          </TouchableOpacity>
        </View>

        <SortPickerModal
          visible={isSortPickerVisible}
          fields={sortFieldOptions}
          sortField={sortField}
          sortDirection={sortDirection}
          onSelect={(fieldName) => handleSelectSortField(fieldName)}
          onClose={() => setIsSortPickerVisible(false)}
        />
        </>
      )}

      <HamburgerMenu
        visible={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        walletCount={wallets.length}
        currentScreen={currentScreen}
        isBusy={isFetching || isRetrying || walletAddresses.length === 0}
        onSelectWallets={() => handleMenuSelectScreen('wallets')}
        onSelectFetch={handleMenuSelectFetch}
        onSelectScreen={handleMenuSelectScreen}
      />

      {walletAddresses.length > 0 ? (
        <CollectionView
          kind={currentScreen}
          ownerAddresses={walletAddresses}
          refreshKey={refreshKey}
          searchText={searchText}
          starFilter={starFilter}
          onStarFilterChange={setStarFilter}
          viewMode={viewMode}
          sortField={sortField}
          sortDirection={sortDirection}
        />
      ) : (
        !isFetching && (
          <View style={styles.centeredContainer}>
            <Text style={[styles.hintText, { color: colors.secondaryText }]}>
              First add a wallet, then scan the chain: tap the ☰ menu below, choose Wallets to add your address, then choose Fetch/Update to see your Devikins, Weapons, and Equipment.
            </Text>
            <TouchableOpacity
              style={[styles.hamburgerButton, styles.emptyStateMenuButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              onPress={() => setIsMenuOpen(true)}
            >
              <Text style={[styles.hamburgerIcon, { color: colors.text }]}>☰</Text>
            </TouchableOpacity>
          </View>
        )
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centeredContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  // The loading/splash screen's "Devikins" / "Legacy" title, and the
  // smaller status line underneath it - see the !isDatabaseReady check
  // above.
  splashTitleLine: {
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 42,
  },
  // The "Companion" tagline under the main title - same family as the
  // title lines above (bold, centered) but noticeably smaller, so it
  // reads as a subtitle to "Devikins Legacy" rather than a third
  // equally-weighted line.
  splashTagline: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  splashSubtitle: {
    marginTop: 24,
    fontSize: 14,
    textAlign: 'center',
  },
  // Pinned to the bottom of the splash screen. Wrapped in a plain View
  // (splashVersionWrap) with position: 'absolute' + left: 0 + right: 0,
  // the same reliable pattern already used for the NFT count text in
  // CollectionView.js (see countTextWrap there) - putting position:
  // 'absolute' directly on a bare <Text> with alignSelf: 'center' turned
  // out not to render reliably, so this sticks to the version already
  // proven to work.
  // `bottom` is NOT set here - it's added inline where this style is
  // used, as `insets.bottom + 16` (see the useSafeAreaInsets() call in
  // AppContent), since a fixed number here got covered by the Android
  // navigation bar on real devices. Reading the actual inset directly
  // guarantees clearance regardless of 3-button vs. gesture navigation,
  // or whether SafeAreaView's own automatic edge padding has accounted
  // for it correctly on a given device.
  splashVersionWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  splashVersion: {
    textAlign: 'center',
    fontSize: 12,
  },
  hintText: {
    textAlign: 'center',
  },
  // Gives the empty-state ☰ button below the hint text some breathing
  // room, and centers it - it's a plain sibling of the hint Text inside
  // the same centered container, not part of the normal top menuRow
  // (which isn't rendered at all in the zero-wallets state, since
  // walletAddresses.length > 0 gates the whole search row, but the
  // hamburger button itself is still needed here so a fresh install has
  // an obvious way to open the menu without hunting for it).
  emptyStateMenuButton: {
    marginTop: 20,
  },
  // The search field plus the List/Tiles toggle on the right (moved up
  // here from CollectionView.js, per feedback) - the theme toggle that
  // used to share this row moved up onto menuRow's top-right instead
  // (see its own comment above). Sits below menuRow (which carries the
  // status-bar clearance padding, being the first row on screen), so
  // this one just needs its own small breathing room, not a big top gap.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 10,
  },
  // Wraps the search field so the "✕" clear button (searchClearButton
  // below) can be absolutely positioned over its right edge, rather
  // than needing its own spot in searchRow's layout.
  searchInputWrapper: {
    flex: 1,
    position: 'relative',
    justifyContent: 'center',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    // Extra room on the right so typed text never runs under the clear
    // button - see searchClearButton below.
    paddingRight: 34,
    paddingVertical: 8,
  },
  searchClearButton: {
    position: 'absolute',
    right: 10,
    padding: 4,
  },
  searchClearButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  viewModeButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  // Explicit lineHeight (rather than leaving it to the default) so
  // this renders at exactly the same height as sortButtonText below,
  // even though the two show different characters - see that style's
  // own comment for why that isn't automatic.
  viewModeButtonText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  // The Sort button - same border/radius/padding as viewModeButton
  // above so all three controls in this row line up at the same
  // height. That match isn't automatic just from matching padding,
  // though: this button's label always starts with an arrow character
  // (↑/↓), and on at least one device (Raphael's Samsung tablet) that
  // glyph rendered with a taller default line height than the plain
  // "List"/"Tiles" text, making this button visibly shorter than tall
  // (padding matched, but the extra line height pushed its own box
  // taller than the other two). Pinning both this and
  // viewModeButtonText to the SAME explicit lineHeight removes that
  // platform-dependent difference instead of guessing at a fix that
  // might not hold on every device/font.
  sortButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 110,
  },
  sortButtonText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  // The very first row on screen: the ☰ hamburger button on the left,
  // the light/dark theme toggle on the right (per feedback - it used to
  // share a row with the search field below instead). Carries the extra
  // breathing room that used to live on searchRow, so nothing here is
  // crowded by the phone's own status bar / notch / Dynamic Island
  // controls, since this is the top-most row now.
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 28,
    paddingBottom: 12,
  },
  // Wraps ProgressBar when it's shown inline in menuRow (see the JSX
  // comment above) - flex: 1 so it takes up whatever horizontal space
  // is left between the hamburger button and the theme toggle, rather
  // than sizing to its own content and potentially overlapping either
  // one.
  inlineProgressWrapper: {
    flex: 1,
    marginHorizontal: 10,
  },
  hamburgerButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hamburgerIcon: {
    fontSize: 20,
    fontWeight: '600',
  },
  // Same look the old theme toggle button always had - unchanged, just
  // relocated onto searchRow above (having previously been relocated
  // onto menuRow, back when Fetch/Update and Wallets moved into the
  // hamburger menu instead of sharing this row with it).
  themeToggle: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  themeToggleIcon: {
    fontSize: 16,
  },
  themeToggleLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
