/**
 * App.js
 *
 * The root of the whole app. This is the file Expo runs first. It's
 * responsible for:
 *
 *   - Wrapping everything in a ThemeProvider, so light/dark mode is
 *     available to every screen (see src/context/ThemeContext.js).
 *   - Setting up the local database once, when the app starts.
 *   - Rendering the persistent top bar (search field + exact star-rating
 *     filter, see StarRating.js) shown above the Devikins/Weapons/
 *     Equipment screens, and the ☰ hamburger button underneath it that
 *     opens HamburgerMenu.js - a full-screen menu that replaced the old
 *     tab bar and the old Fetch/Update + Wallets buttons that used to
 *     sit at the top of the screen. See HamburgerMenu.js's own file
 *     comment for the six menu entries and what each one does.
 *   - Kicking off fetchAllForWallets.js when Fetch/Update is tapped (now
 *     from inside the menu), and tracking its progress/cancellation.
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
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { initDatabase, getWallets, countPendingRetries } from './src/db/database';
import { fetchAllForWallets, retryPendingItemsForWallets } from './src/api/fetchAllForWallet';
import { COLLECTIONS } from './src/constants/schema';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import HamburgerMenu from './src/components/HamburgerMenu';
import StarRating from './src/components/StarRating';
import CollectionView from './src/components/CollectionView';
import ProgressBar from './src/components/ProgressBar';
import WalletManager from './src/components/WalletManager';
import Feedback from './src/components/Feedback';
import HelpAssistant from './src/components/HelpAssistant';
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

  // How often to check for anything left unfinished (failed items,
  // missing images) and quietly retry it in the background, how many
  // times in a row to try at that fast pace, and how long to wait between
  // attempts after that fast pace is used up. At one retry round per
  // minute, 10 rounds is about 10 minutes of fast automatic retrying -
  // after that, rather than giving up completely, it backs off to
  // checking only once an hour, indefinitely, for as long as the app
  // stays open. The idea: a brief blip deserves quick retries, but if
  // something's still broken after 10 minutes straight, a longer-lived
  // problem (like the metadata API being down, or - per your suspicion -
  // something time-related on the game's own side) is more likely, and
  // there's no point hammering it every minute forever. Tapping
  // Fetch/Update manually always resets straight back to the fast pace.
  const AUTO_RETRY_INTERVAL_MS = 60000;
  const MAX_AUTO_RETRY_ROUNDS = 10;
  const SLOW_RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // How long to keep the "Devikins Legacy" loading screen on screen at
  // minimum, in milliseconds. The database itself sets up almost
  // instantly (well under a second), so without this the loading screen
  // would flash by too quickly to read - this holds it for a fixed
  // 3 seconds instead, per feedback to shorten it.
  const MIN_SPLASH_DURATION_MS = 3000;

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
  // star-rating filter (0 = no rating filter, 1-5 = show only that exact
  // rating) - both live here rather than inside CollectionView because,
  // unlike the per-collection trait filters CollectionView already
  // manages, these two are meant to carry over as you switch between
  // Devikins/Weapons/Equipment (searching "123" and then checking
  // another tab for the same search is the expected behavior, not a
  // bug - see CollectionView.js's own filter-reset effect, which
  // deliberately does NOT touch these two).
  const [searchText, setSearchText] = useState('');
  const [starFilter, setStarFilter] = useState(0);

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

  // Whether the background auto-retry timer is currently running a round,
  // and what it's up to (shown via the same ProgressBar component the
  // manual Fetch uses, so it looks consistent).
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryProgress, setRetryProgress] = useState(null);

  // True while EITHER a manual fetch or an automatic retry round is in
  // flight - used to stop the two from ever overlapping (which could
  // otherwise have both try to touch the same nonce at once).
  const busyRef = useRef(false);

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

  // A plain mutable ref (not React state) that the in-progress fetch
  // checks between steps to know whether the user asked it to stop. It's
  // a ref rather than state because setting it doesn't need to cause a
  // re-render by itself - only the Stop button's own UI needs updating,
  // and that happens through isFetching/progress instead.
  const cancelRequestedRef = useRef(false);

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
  //   2. Else, if Wallets or Feedback is showing, go back to whichever
  //      collection screen (devikin/weapon/equipment) was showing before
  //      it was opened.
  //   3. Otherwise, this component has nothing to close - step aside
  //      (return false) and let CollectionView.js's OWN matching
  //      listener handle closing an open NFT detail view, or let Android
  //      do its normal thing (exit) if there's nothing open there either.
  // The two listeners never conflict, since CollectionView isn't even
  // mounted while Wallets/Feedback is showing (see the render logic
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
      return false; // nothing here to close - let Android/CollectionView handle it
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
    // backed off to the slow hourly one).
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

  // The automatic retry timer: every AUTO_RETRY_INTERVAL_MS, if nothing
  // else is currently fetching, check whether any saved wallet has
  // anything left unfinished (failed items, or items missing a cached
  // image) and quietly retry just those - see
  // retryPendingItemsForWallets in fetchAllForWallet.js. This is what
  // fixes "some items stayed failed/imageless after the last Fetch"
  // without the user having to keep tapping Fetch by hand.
  useEffect(() => {
    if (walletAddresses.length === 0) return undefined;

    retryRoundRef.current = 0;
    nextRetryAtRef.current = 0;

    const intervalId = setInterval(async () => {
      // Skip this tick entirely if something else is already running, or
      // if we've backed off to the slow pace and it isn't time yet - this
      // is the only difference from the original fast-only version: the
      // timer itself still ticks every minute, but most of those ticks
      // are no-ops once nextRetryAtRef has been pushed an hour out.
      if (busyRef.current || Date.now() < nextRetryAtRef.current) {
        return;
      }

      const pending = await countPendingRetries(walletAddresses);
      if (pending.total === 0) {
        // Fully caught up - reset both the round count and the pace, so
        // a future problem gets a full fast burst of retry attempts
        // again rather than starting from wherever the pace last left
        // off.
        retryRoundRef.current = 0;
        nextRetryAtRef.current = 0;
        return;
      }

      retryRoundRef.current += 1;
      busyRef.current = true;
      cancelRequestedRef.current = false;
      setIsRetrying(true);

      // Say up front what KIND of work this round is about to do - a
      // full NFT refetch (metadata never came through) is a different,
      // slower thing than just retrying an image, so it's worth being
      // specific rather than a generic "N item(s)" count.
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

        // Once the fast burst is used up, don't check again for another
        // hour instead of giving up for good - see the constants' file
        // comment above for why. This re-applies every hourly round too
        // (not just the first time), so it keeps retrying once an hour
        // indefinitely rather than only backing off once.
        if (retryRoundRef.current >= MAX_AUTO_RETRY_ROUNDS) {
          nextRetryAtRef.current = Date.now() + SLOW_RETRY_INTERVAL_MS;
        }
      }
    }, AUTO_RETRY_INTERVAL_MS);

    return () => clearInterval(intervalId);
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

      {/* The top search bar - search by NFT name/custom name or ID, plus
          the exact-match 1-5 star filter (see StarRating.js's own
          comment for why this one uses mode="exact" rather than the
          usual cumulative star-rating look). Only shown once there's at
          least one wallet - with nothing fetched yet there's nothing to
          search or filter, same reasoning the old tab bar/CollectionView
          used to decide whether to show themselves at all. */}
      {walletAddresses.length > 0 && (
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
            placeholder="Search by name or ID"
            placeholderTextColor={colors.secondaryText}
            value={searchText}
            onChangeText={setSearchText}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <StarRating value={starFilter} onChange={setStarFilter} mode="exact" size={18} />
        </View>
      )}

      {/* The ☰ hamburger button (left) opens HamburgerMenu.js - see its
          file comment for the six entries (Wallets, Fetch/Update,
          Devikins, Weapons, Equipment, Feedback) that used to be spread
          across the old Fetch/Wallets buttons and tab row. The dark-mode
          toggle (right) is unchanged from before, just moved down onto
          this row now that the row above it is taken up by search. */}
      <View style={styles.menuRow}>
        <TouchableOpacity
          style={[styles.hamburgerButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
          onPress={() => setIsMenuOpen(true)}
        >
          <Text style={[styles.hamburgerIcon, { color: colors.text }]}>☰</Text>
        </TouchableOpacity>

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

      {isFetching && <ProgressBar progress={progress} onCancel={handleCancelPress} isCancelling={isCancelling} />}
      {isRetrying && <ProgressBar progress={retryProgress} onCancel={handleCancelPress} isCancelling={isCancelling} />}

      {walletAddresses.length > 0 ? (
        <CollectionView
          kind={currentScreen}
          ownerAddresses={walletAddresses}
          refreshKey={refreshKey}
          searchText={searchText}
          starFilter={starFilter}
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
  // The search bar row - a text input (search by name or ID) on the
  // left, the exact-match star filter (StarRating.js) on the right.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    // Extra breathing room above the search bar, so it isn't crowded by
    // the phone's own status bar / notch / Dynamic Island controls -
    // same spirit as the old inputColumn's paddingTop.
    paddingTop: 28,
    paddingBottom: 10,
  },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  // The row directly under the search bar: the ☰ hamburger button on the
  // left ("under search and top/left", per how this was designed), the
  // theme toggle on the right.
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
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
  // relocated onto menuRow now that Fetch/Update and Wallets have moved
  // into the hamburger menu instead of sharing this row with it.
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
