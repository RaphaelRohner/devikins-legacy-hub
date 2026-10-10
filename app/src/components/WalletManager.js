/**
 * WalletManager.js
 *
 * The "Wallets" screen, opened from the hamburger menu (see
 * HamburgerMenu.js's first entry - V2 moved this out of a dedicated
 * top-of-screen button, but the screen itself is unchanged). Lets the
 * user manage the list of wallet addresses the app fetches from - add a
 * new one, edit an existing one (e.g. to fix a typo), or remove one -
 * the classic four CRUD operations (Create/Read/Update/Delete), each one
 * just a plain button, per the project's request.
 *
 * Like every other "screen" in this app (the NFT detail view in
 * CollectionView.js is the other example), this isn't a real navigation
 * stack - it's just App.js swapping what it renders based on its
 * `currentScreen` state (`currentScreen === 'wallets'`), with its own
 * small round "‹" back button (top-left corner) to swap back to
 * whichever collection screen
 * was showing before. See App.js's own file comment for why the whole
 * app is built this way instead of using a navigation library.
 *
 * This component doesn't keep its own copy of the wallet list - it always
 * shows exactly the `wallets` array App.js passes in, and calls
 * `onWalletsChanged` after every add/edit/delete so App.js can reload that
 * list from the database and pass the fresh version back down. That keeps
 * "what wallets exist" living in exactly one place (the database, read
 * through App.js) rather than two copies that could drift out of sync.
 *
 * The "Add a wallet" row also has a camera button (see
 * QrScannerModal.js) as an alternative to typing/pasting an address -
 * it only fills the same text field a paste would, so Add still works
 * exactly the same way either way the address got there.
 *
 * Later addition: wallet sets, at the very top of this screen, above
 * the "Add a wallet" row. A wallet set is a completely separate named
 * collection - its own wallets, its own fetched NFTs, its own
 * downloaded images (see database.js's "Wallet sets" section for the
 * full reasoning) - so everything below the switcher (the Add row, the
 * wallet list, Danger Zone's per-item behavior) is always scoped to
 * whichever set is currently active, exactly the way this whole screen
 * already worked before sets existed, just now switchable. `walletSets`
 * and `activeWalletSetId` follow the exact same "App.js owns the real
 * list, this component just calls a changed-callback to get a fresh
 * copy back" pattern the `wallets` prop above already uses -
 * `onWalletSetsChanged` plays the same role `onWalletsChanged` does for
 * individual wallets, just one level up. Per feedback once this was in
 * daily use, "+ New set" sits right under the explanation text, above
 * the list of existing sets, rather than below it - the action you'd
 * take most often (starting a new set) shouldn't require scrolling
 * past however many sets already exist to find it.
 *
 * When no set is active at all (this happens if the previously-active
 * set was deleted and nothing new was picked yet), the Add row and
 * wallet list are replaced with a short explanation instead of
 * rendering against data that doesn't exist - see the
 * `activeWalletSetId` check partway through this file.
 *
 * Danger zone (bottom of the list) sits behind its own always-visible
 * toggle, off by default - also per feedback: a screen opened this
 * often (Wallets) shouldn't put a destructive, whole-app-wiping button
 * in view every single time, but it should still be easy to find on
 * purpose rather than buried somewhere else entirely.
 *
 * Another round of feedback once wallet sets were in daily use: it
 * wasn't obvious that the Add row and the wallet list below the
 * switcher belonged to whichever set was active - "+ New set", the
 * existing sets, the Add row, and the wallet list all just ran
 * together with nothing marking where one part ended and the next
 * began. Fixed with two small headlines rather than restructuring the
 * layout: the switcher section is now labeled "Wallet sets" (plural,
 * since it's the list of sets, not the active one), and a second
 * headline right above the Add row/wallet list reads
 * `Wallets in "<active set name>"`, so it's clear at a glance which
 * set everything below it belongs to.
 */

import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Switch,
  BackHandler,
} from 'react-native';
import {
  addWallet,
  updateWalletAddress,
  deleteWallet,
  resetAllData,
  createWalletSet,
  renameWalletSet,
  switchToWalletSet,
  deleteWalletSet,
} from '../db/database';
import { useTheme } from '../context/ThemeContext';
import QrScannerModal from './QrScannerModal';
// Website only: "Connect Klever Extension" reads the address of the
// wallet open in the Klever browser extension and adds it here, so nobody
// has to copy and paste it. Only the public address is read.
import { connectExtension } from '../api/kleverExtension';
import { getStorageBytesForSets, formatBytes } from '../api/storageStats';
import {
  exportWalletSet,
  exportAllWalletSets,
  shareExportedFile,
  saveExportedFileToFolder,
  pickAndImportWalletSetsZip,
  supportsSaveToFolder,
} from '../api/exportImport';

// Exporting and importing wallet sets uses the phone's file system and
// share sheet, which the website doesn't have yet - so on the web those
// buttons are hidden for now. Everything else works the same.
const IS_WEB = Platform.OS === 'web';

export default function WalletManager({
  wallets,
  onWalletsChanged,
  walletSets,
  activeWalletSetId,
  onWalletSetsChanged,
  onClose,
}) {
  const { colors } = useTheme();

  // The "Add a wallet" text field at the top.
  const [newAddressInput, setNewAddressInput] = useState('');
  // Whether the QR scanner overlay (QrScannerModal.js) is currently open.
  const [isScannerVisible, setIsScannerVisible] = useState(false);
  // Website only: true while waiting for the Klever extension to answer.
  const [isConnectingExtension, setIsConnectingExtension] = useState(false);

  // Which wallet row (by id) is currently being edited, if any - only one
  // at a time. While a row is being edited, its own address text is
  // replaced with an editable text field plus Save/Cancel buttons instead
  // of the usual Edit/Delete buttons.
  const [editingId, setEditingId] = useState(null);
  const [editAddressInput, setEditAddressInput] = useState('');
  // The optional friendly name (e.g. "Main", "Trading") - edited
  // alongside the address, and shown next to the Edit/Delete buttons
  // once saved (see the non-edit row below).
  const [editAliasInput, setEditAliasInput] = useState('');

  // Wallet-set switcher state - same shape as the per-wallet edit state
  // above, just one level up. "Creating" and "renaming" are separate
  // flags (rather than reusing editingId) since renaming an existing
  // set and typing a brand new set's name are two different rows in the
  // UI below, not the same row toggling modes.
  const [isCreatingSet, setIsCreatingSet] = useState(false);
  const [newSetNameInput, setNewSetNameInput] = useState('');
  const [renamingSetId, setRenamingSetId] = useState(null);
  const [renameSetInput, setRenameSetInput] = useState('');

  // Whether the Danger zone's actual content (the explanation + Reset
  // All Data button) is showing - off by default per Raphael's own
  // request, so a screen you open often (Wallets) doesn't put a
  // destructive, whole-app-wiping button in view every single time.
  // The "Danger zone" label + toggle itself always stays visible so
  // it's still easy to find on purpose.
  const [isDangerZoneVisible, setIsDangerZoneVisible] = useState(false);

  // Real, measured on-disk storage per wallet set (database file +
  // images folder - see storageStats.js), plus a grand total across all
  // of them. Raphael's own worry after testing with ~3,000 NFTs across
  // several sets: it's easy to lose track of how much phone storage
  // several sets add up to, especially the ones built for quick testing
  // rather than kept around. Computed fresh every time this screen
  // mounts (it's fully unmounted/remounted on navigating away - see
  // App.js's own currentScreen === 'wallets' check - so this always
  // reflects whatever's on disk as of the moment Wallets was opened,
  // including anything a Fetch/Update on the home screen added since
  // the last visit). Keyed by set id rather than a plain array so each
  // row below can look its own number up directly.
  const [storageBytesById, setStorageBytesById] = useState({});
  const [totalStorageBytes, setTotalStorageBytes] = useState(null);
  const [isCalculatingStorage, setIsCalculatingStorage] = useState(false);

  // V3.1: export/import. isExportingId is either null (nothing
  // exporting right now), a wallet set's own id (that set's own Export
  // button was pressed), or the literal string 'all' (Export all sets
  // was pressed) - used both to show a progress label on the right
  // button and to disable every OTHER export button while one export is
  // already running, since two exports at once would mean two full zips
  // being built in memory at the same time (see exportImport.js's own
  // file comment on how much memory just ONE of those can already use).
  const [isExportingId, setIsExportingId] = useState(null);
  const [exportProgressLabel, setExportProgressLabel] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importProgressLabel, setImportProgressLabel] = useState('');

  // Raphael's own call after testing this for real: "forcing the user
  // to just let an export or import finish is probably the safest
  // approach" - switching sets, deleting a set, editing a wallet, and
  // Reset All Data all touch the very same underlying files/database an
  // export or import is actively reading or writing. isBusy (further
  // down, right before the JSX that uses it) is what the render logic
  // checks to gray out and disable every one of those actions while
  // either is running - this effect handles the one path plain
  // `disabled` props can't reach: Android's hardware Back button/
  // gesture. Same shape as CollectionView.js's own hardwareBackPress
  // listener - React Native calls the most-recently-registered listener
  // first, and this component is mounted deeper in the tree than
  // App.js's own listener, so returning true here (while busy) reaches
  // the user and stops App.js from ever navigating away, without this
  // file needing to know anything about App.js's own screen-switching
  // logic.
  useEffect(() => {
    function handleBackPress() {
      if (isExportingId !== null || isImporting) {
        Alert.alert(
          'Please wait',
          'An export or import is still running - leaving now would lose its progress. Give it a moment to finish first.'
        );
        return true; // handled - swallow the press, don't let App.js navigate away
      }
      return false; // nothing running here - let App.js's own listener handle Back as usual
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => subscription.remove();
  }, [isExportingId, isImporting]);

  useEffect(() => {
    let cancelled = false;
    setIsCalculatingStorage(true);

    getStorageBytesForSets(walletSets)
      .then(({ perSet, grandTotalBytes }) => {
        if (cancelled) return;
        const byId = {};
        for (const set of perSet) byId[set.id] = set.totalBytes;
        setStorageBytesById(byId);
        setTotalStorageBytes(grandTotalBytes);
      })
      .catch((err) => {
        // Storage display is a nice-to-have, not core functionality -
        // if this fails for some reason (a locked file, an odd
        // permissions state), just leave the numbers blank rather than
        // interrupting the whole screen with an error over something
        // this non-essential.
        console.log('[WalletManager] Storage calculation failed:', err.message);
      })
      .finally(() => {
        if (!cancelled) setIsCalculatingStorage(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletSets]);

  // Every wallet-set action below (create/switch/rename/empty/delete)
  // used to let a failed database call disappear silently - nothing
  // thrown ever reached the screen, so a broken switch just looked like
  // "nothing happened" with no way to tell what actually went wrong.
  // Raphael ran into exactly that after deleting the active set and
  // then being unable to select a different one. Wrapping each action
  // below in try/catch and surfacing whatever error comes back through
  // a plain Alert means a future failure is at least visible and
  // debuggable instead of invisible, regardless of what's actually
  // causing it.
  function reportSetActionError(err, actionLabel) {
    console.error(`Wallet set action failed (${actionLabel}):`, err);
    Alert.alert(
      'Something went wrong',
      `${actionLabel} didn't complete: ${err?.message || String(err)}`
    );
  }

  async function handleAdd() {
    const trimmedAddress = newAddressInput.trim();
    if (!trimmedAddress) return;

    // This is the very first wallet ever added if the list App.js
    // handed us is still empty right now - a one-time heads-up that the
    // FIRST fetch (once they go tap Fetch/Update) will take a while,
    // since there's nothing cached yet and every NFT has to be looked
    // up fresh. Later wallets don't get this popup - by then the user
    // already knows what to expect.
    const isFirstWalletEver = wallets.length === 0;

    await addWallet(trimmedAddress);
    setNewAddressInput('');
    onWalletsChanged();

    if (isFirstWalletEver) {
      Alert.alert(
        'Wallet added',
        "Next, tap Fetch/Update on the home screen to pull in its Devikins, Weapons, and Equipment. The first fetch can take a few minutes, since nothing is cached yet - after that, updates are much faster."
      );
    }
  }

  async function handleConnectExtension() {
    setIsConnectingExtension(true);
    try {
      const { address } = await connectExtension();
      if (wallets.some((w) => w.address === address)) {
        Alert.alert('Already added', `The wallet from your Klever extension is already in this list:\n\n${address}`);
        return;
      }
      const isFirstWalletEver = wallets.length === 0;
      await addWallet(address);
      onWalletsChanged();
      Alert.alert(
        'Wallet added',
        `${address}\n\nThis is the wallet open in your Klever extension.` +
          (isFirstWalletEver ? ' Next, choose Fetch/Update in the menu to load its Devikins, Weapons, and Equipment.' : '')
      );
    } catch (err) {
      Alert.alert('Klever extension', err?.message || String(err));
    } finally {
      setIsConnectingExtension(false);
    }
  }

  // Fills the same field handleAdd reads from, rather than adding the
  // wallet directly - see the file comment above for why. Doesn't
  // auto-submit, so a scan that came out wrong (or a QR that wasn't
  // actually a plain address) is still visible and editable, same as
  // if it had been pasted in by hand.
  function handleScanned(scannedAddress) {
    setNewAddressInput(scannedAddress);
    setIsScannerVisible(false);
  }

  function handleStartEdit(wallet) {
    setEditingId(wallet.id);
    setEditAddressInput(wallet.address);
    setEditAliasInput(wallet.alias || '');
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditAddressInput('');
    setEditAliasInput('');
  }

  async function handleSaveEdit(id) {
    const trimmedAddress = editAddressInput.trim();
    if (!trimmedAddress) return;
    await updateWalletAddress(id, trimmedAddress, editAliasInput);
    setEditingId(null);
    setEditAddressInput('');
    setEditAliasInput('');
    onWalletsChanged();
  }

  async function handleDelete(id) {
    // No confirmation dialog on purpose, to match the rest of this app's
    // plain, direct style - deleting a wallet here only stops it from
    // being fetched/shown, it doesn't erase any of its already-saved NFT
    // data (see deleteWallet's own comment in database.js), so it's a
    // low-risk, easily-undone action (just re-add the same address).
    if (editingId === id) {
      setEditingId(null);
      setEditAddressInput('');
    }
    await deleteWallet(id);
    onWalletsChanged();
  }

  // Creates a brand-new, empty wallet set and switches straight into
  // it - naming and starting to use it are the same action here (see
  // createWalletSet's own comment in database.js for why). A blank name
  // isn't an error - database.js falls back to "New Set" on its own,
  // same as leaving a wallet's alias blank just means "no name" rather
  // than being rejected.
  async function handleCreateSet() {
    try {
      await createWalletSet(newSetNameInput);
      setNewSetNameInput('');
      setIsCreatingSet(false);
      onWalletSetsChanged();
    } catch (err) {
      reportSetActionError(err, 'Creating the set');
    }
  }

  function handleCancelCreateSet() {
    setNewSetNameInput('');
    setIsCreatingSet(false);
  }

  // Switching to the set you're already on would just be a no-op
  // database round-trip for nothing, so this skips it entirely rather
  // than calling switchToWalletSet unnecessarily.
  async function handleSwitchSet(id) {
    if (id === activeWalletSetId) return;
    try {
      await switchToWalletSet(id);
      onWalletSetsChanged();
    } catch (err) {
      reportSetActionError(err, 'Loading that set');
    }
  }

  function handleStartRenameSet(set) {
    setRenamingSetId(set.id);
    setRenameSetInput(set.name);
  }

  function handleCancelRenameSet() {
    setRenamingSetId(null);
    setRenameSetInput('');
  }

  async function handleSaveRenameSet(id) {
    const trimmedName = renameSetInput.trim();
    if (!trimmedName) return;
    try {
      await renameWalletSet(id, trimmedName);
      setRenamingSetId(null);
      setRenameSetInput('');
      onWalletSetsChanged();
    } catch (err) {
      reportSetActionError(err, 'Renaming that set');
    }
  }

  // Permanently deletes one wallet set - its wallets, its NFTs, and its
  // downloaded images, gone for good (see deleteWalletSet's own comment
  // in database.js). Works on any set in the list, not just the active
  // one, so a set that turned out to be a mistake (e.g. the wrong
  // address pulled in a huge pile of broken entries) can be cleared out
  // without first switching into it. Gets the same style of destructive
  // confirmation as Reset All Data below, just scoped to one set.
  function handleDeleteSet(set) {
    Alert.alert(
      `Delete "${set.name}"?`,
      'This permanently deletes every wallet, NFT, and downloaded image saved under this set. This cannot be undone - your actual NFTs are safe on the blockchain either way.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Set',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteWalletSet(set.id);
              onWalletSetsChanged();
            } catch (err) {
              reportSetActionError(err, 'Deleting that set');
            }
          },
        },
      ]
    );
  }

  // Turns an exportImport.js onProgress callback into the one-line
  // status text shown on whichever Export/Import button is currently
  // running - shared by handleExportSet/handleExportAllSets/handleImport
  // below, since export and import report overlapping phases (both read
  // a stream of images) and the rest are specific to one direction.
  // Raphael's own request, once the Export button had this and the
  // Import button was still stuck on a plain "Importing..." the whole
  // time regardless of how big the file was. Returns null for a phase
  // this doesn't recognize, rather than guessing - callers already fall
  // back to their own generic "Exporting.../Importing..." label whenever
  // this hasn't produced anything more specific yet (e.g. before the
  // first progress event arrives at all).
  function describeTransferProgress(progress) {
    if (progress.phase === 'reading-images') {
      return `Reading images... ${progress.current}/${progress.total}`;
    }
    if (progress.phase === 'zipping') return 'Compressing...';
    if (progress.phase === 'writing') return 'Writing file...';
    // Import's own read phase - see importWalletSetsZipFromLocalFile's
    // onProgress call in exportImport.js. Tracked in bytes rather than a
    // file count (it covers manifest.json/database.json too, not just
    // images), so this uses formatBytes the same way the storage totals
    // elsewhere on this screen already do, rather than showing raw byte
    // numbers.
    if (progress.phase === 'unzipping') {
      return `Reading files... ${formatBytes(progress.current)} / ${formatBytes(progress.total)}`;
    }
    // Rebuilding a set's actual data from its dump (restoreWalletSetData
    // in database.js) - can take real time on its own for a large set,
    // well after every byte's already been read, so this needs its own
    // distinct label rather than leaving "Reading files..." sitting at
    // 100% while it happens.
    if (progress.phase === 'restoring') {
      // Raphael's own report: this used to just sit on a bare
      // "Rebuilding ..." for however long a big set's row-by-row
      // restore took, with nothing telling him where it actually was -
      // see restoreWalletSetData's own onProgress in database.js for
      // the row count this now carries.
      const label = progress.setName ? `Rebuilding "${progress.setName}"...` : 'Rebuilding data...';
      if (progress.current != null && progress.total) {
        return `${label} ${progress.current}/${progress.total}`;
      }
      return label;
    }
    return null;
  }

  // Raphael's own explicit request: rather than picking one of "share
  // it" or "save it to a folder" up front, ask which one he wants once
  // the file's actually ready, and only then do that one thing - Share
  // opens the OS share sheet (works everywhere), Save to folder (Android
  // only - see supportsSaveToFolder/saveExportedFileToFolder's own
  // comment in exportImport.js) asks Android for a destination folder
  // and copies the file there directly.
  function presentSaveOrShareChoice(fileUri, fileName) {
    return new Promise((resolve) => {
      const buttons = [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
        {
          text: 'Share',
          onPress: async () => {
            try {
              await shareExportedFile(fileUri);
            } catch (err) {
              reportSetActionError(err, 'Sharing the export');
            }
            resolve();
          },
        },
      ];
      if (supportsSaveToFolder) {
        buttons.push({
          text: 'Save to folder',
          onPress: async () => {
            try {
              const saved = await saveExportedFileToFolder(fileUri, fileName);
              if (saved) {
                Alert.alert('Saved', `${fileName} was saved to the folder you picked.`);
              }
            } catch (err) {
              reportSetActionError(err, 'Saving the export');
            }
            resolve();
          },
        });
      }
      Alert.alert(
        'Export ready',
        `${fileName} is ready. Where would you like to send it?`,
        buttons,
        { cancelable: true, onDismiss: () => resolve() }
      );
    });
  }

  async function handleExportSet(set) {
    setIsExportingId(set.id);
    setExportProgressLabel('Preparing export...');
    try {
      const { fileUri, fileName } = await exportWalletSet(set, {
        onProgress: (progress) => setExportProgressLabel(describeTransferProgress(progress)),
      });
      await presentSaveOrShareChoice(fileUri, fileName);
    } catch (err) {
      reportSetActionError(err, 'Exporting that set');
    } finally {
      setIsExportingId(null);
      setExportProgressLabel('');
    }
  }

  async function handleExportAllSets() {
    setIsExportingId('all');
    setExportProgressLabel('Preparing export...');
    try {
      const { fileUri, fileName } = await exportAllWalletSets(walletSets, {
        onProgress: (progress) => setExportProgressLabel(describeTransferProgress(progress)),
      });
      await presentSaveOrShareChoice(fileUri, fileName);
    } catch (err) {
      reportSetActionError(err, 'Exporting all sets');
    } finally {
      setIsExportingId(null);
      setExportProgressLabel('');
    }
  }

  // Imports one or more wallet sets from a zip Raphael previously
  // exported (from this phone or another one) - see exportImport.js's
  // own file comment for the full reasoning. A cancelled file picker
  // comes back as null, not an error, so that's treated as a quiet
  // no-op rather than an "Import failed" alert over Raphael simply
  // backing out of the picker.
  async function handleImport() {
    setIsImporting(true);
    setImportProgressLabel('Preparing import...');
    try {
      const result = await pickAndImportWalletSetsZip({
        onProgress: (progress) => setImportProgressLabel(describeTransferProgress(progress)),
      });
      if (result === null) {
        return;
      }
      const { importedNames, warnings } = result;
      onWalletSetsChanged();
      let message;
      if (importedNames.length === 0) {
        message = "That file didn't contain any wallet sets.";
      } else {
        message = `Added: ${importedNames.join(', ')}. Use the switcher above to load one.`;
        // Every file this app exports carries a checksum (see
        // exportImport.js's crc32Bytes/copyEntryBytesTo) that import
        // re-checks against what actually landed on the phone - so this
        // message can say for real whether everything (including every
        // image) came through identical, not just that the import
        // finished without crashing.
        message += warnings.length > 0
          ? `\n\n${warnings.join('\n\n')}`
          : ' Every file, including every image, was checked against the export and matched exactly.';
      }
      Alert.alert(importedNames.length > 0 ? 'Import complete' : 'Nothing imported', message);
    } catch (err) {
      reportSetActionError(err, 'Importing that file');
    } finally {
      setIsImporting(false);
      setImportProgressLabel('');
    }
  }

  // Wipes every wallet set entirely - every wallet, every saved NFT,
  // and every downloaded image, across ALL sets, not just the active
  // one - back to exactly what a brand-new install looks like (a single
  // fresh "My Wallets" set, empty). Mainly a testing convenience (so the
  // whole app can be exercised again "from scratch" without uninstalling
  // Expo Go, which would wipe every OTHER Expo Go project on this phone
  // too, not just this one). This DOES permanently erase everything, so
  // it gets an actual confirmation prompt first, matching how
  // destructive an action it really is - the one button on this whole
  // screen bigger than a single set's own Delete above.
  function handleResetAllData() {
    Alert.alert(
      'Reset all data?',
      'This deletes every wallet set, every saved wallet, and every Devikin, Weapon, and Equipment NFT stored on this phone, along with their downloaded images. This cannot be undone - your actual NFTs are safe on the blockchain either way, but you will need to re-add your wallet(s) and fetch again from scratch.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetAllData();
              onWalletSetsChanged();
            } catch (err) {
              reportSetActionError(err, 'Resetting all data');
            }
          },
        },
      ]
    );
  }

  // The active set's own name, shown as a headline right above the Add
  // row and wallet list below (see the JSX further down) - per
  // Raphael's own feedback, without this it isn't obvious to a new
  // user that the Add-a-wallet row and the list beneath it belong to
  // whichever set is currently loaded, rather than to wallet sets in
  // general. Falls back to an empty string rather than undefined if,
  // for some reason, activeWalletSetId doesn't match anything in
  // walletSets yet (a render before a state update has caught up) -
  // this headline only ever actually shows while activeWalletSetId is
  // set, so this is just a defensive fallback, not something that
  // should normally happen.
  // Everything below except the export/import buttons themselves reads
  // this - see the hardwareBackPress effect above for the full
  // reasoning behind locking the screen this way.
  const isBusy = isExportingId !== null || isImporting;

  const activeSet = walletSets.find((set) => set.id === activeWalletSetId);
  const activeSetName = activeSet ? activeSet.name : '';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }, isBusy && { opacity: 0.5 }]}
        onPress={() => {
          if (isBusy) {
            Alert.alert(
              'Please wait',
              'An export or import is still running - leaving now would lose its progress. Give it a moment to finish first.'
            );
            return;
          }
          onClose();
        }}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Wallets</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        Fetch/Update pulls Devikins, Weapons, and Equipment from every wallet in your active wallet set below - not every wallet across every set.
      </Text>
      {isBusy ? (
        <Text style={[styles.busyBanner, { color: colors.secondaryText }]}>
          An export or import is running - everything below is disabled until it finishes.
        </Text>
      ) : null}

      {/* Raphael's own report: with enough wallet sets on screen (six
          or seven, in his case), the set switcher below used to be tall
          enough on its own to push "Wallets in <set>" and its address
          list completely off screen, with no way to scroll down to
          reach them - this whole section used to sit above the
          ScrollView, fixed, while only the address list scrolled inside
          it. Moving the ScrollView's start up to here (everything from
          the set switcher down to Danger zone, all one continuous
          scroll region) fixes that - only the back button/title/
          subtitle above stay fixed. */}
      <ScrollView contentContainerStyle={styles.listContent}>
        {/* Wallet set switcher - see this file's own header comment for
            the full reasoning. Everything below this section (the Add
            row, the wallet list, and every per-wallet action) is always
            scoped to whichever set is active here, same as this whole
            screen already worked before sets existed. */}
        <View style={styles.setSwitcherSection}>
          <Text style={[styles.setSwitcherTitle, { color: colors.text }]}>Wallet sets</Text>
          <Text style={[styles.setSwitcherHint, { color: colors.secondaryText }]}>
            Switch between separate, independently saved collections of wallets - useful for a second player in the household, or checking a friend's collection without touching your own.
          </Text>

          <Text style={[styles.setSwitcherStorageTotal, { color: colors.secondaryText }]}>
            {isCalculatingStorage
              ? 'Calculating storage used...'
              : `Total storage used: ${formatBytes(totalStorageBytes ?? 0)} across ${walletSets.length} set${walletSets.length === 1 ? '' : 's'}`}
          </Text>

          {isCreatingSet ? (
            <View style={styles.addRow}>
              <TextInput
                style={[styles.addInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                placeholder="Name this set (e.g. My Wallets)"
                placeholderTextColor={colors.secondaryText}
                value={newSetNameInput}
                onChangeText={setNewSetNameInput}
                autoCapitalize="words"
                autoFocus
                editable={!isBusy}
              />
              <TouchableOpacity
                style={[styles.addButton, { backgroundColor: colors.primary }, isBusy && { opacity: 0.5 }]}
                onPress={handleCreateSet}
                disabled={isBusy}
              >
                <Text style={[styles.addButtonText, { color: colors.primaryText }]}>Create</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                onPress={handleCancelCreateSet}
                disabled={isBusy}
              >
                <Text style={[styles.rowButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.newSetButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
              onPress={() => setIsCreatingSet(true)}
              disabled={isBusy}
            >
              <Text style={[styles.newSetButtonText, { color: colors.text }]}>+ New set</Text>
            </TouchableOpacity>
          )}

          {!IS_WEB ? (
            <View style={styles.backupRow}>
              {!isImporting ? (
                <TouchableOpacity
                  style={[
                    styles.rowButton,
                    styles.backupButton,
                    { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
                    (isExportingId !== null || walletSets.length === 0) && { opacity: 0.5 },
                  ]}
                  onPress={handleExportAllSets}
                  disabled={isExportingId !== null || isImporting || walletSets.length === 0}
                >
                  <Text style={[styles.rowButtonText, { color: colors.text }]} numberOfLines={2}>
                    {isExportingId === 'all' ? (exportProgressLabel || 'Exporting...') : 'Export all sets'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {isExportingId !== 'all' ? (
                <TouchableOpacity
                  style={[
                    styles.rowButton,
                    styles.backupButton,
                    { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
                    (isImporting || isExportingId !== null) && { opacity: 0.5 },
                  ]}
                  onPress={handleImport}
                  disabled={isImporting || isExportingId !== null}
                >
                  <Text style={[styles.rowButtonText, { color: colors.text }]} numberOfLines={2}>
                    {isImporting ? (importProgressLabel || 'Importing...') : 'Import a set'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {walletSets.map((set) => {
            const isActive = set.id === activeWalletSetId;
            const isThisSetExporting = isExportingId === set.id;
            return (
              <View
                key={set.id}
                style={[styles.setRow, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}
              >
                {renamingSetId === set.id ? (
                  <>
                    <TextInput
                      style={[styles.editInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
                      value={renameSetInput}
                      onChangeText={setRenameSetInput}
                      autoCapitalize="words"
                      editable={!isBusy}
                    />
                    <View style={styles.walletRowButtons}>
                      <TouchableOpacity
                        style={[
                          styles.rowButton,
                          { backgroundColor: colors.primary },
                          (isBusy || renameSetInput.trim().length === 0) && { backgroundColor: colors.primaryDisabled },
                        ]}
                        onPress={() => handleSaveRenameSet(set.id)}
                        disabled={isBusy || renameSetInput.trim().length === 0}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.primaryText }]}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                        onPress={handleCancelRenameSet}
                        disabled={isBusy}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.text }]}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <TouchableOpacity
                      style={[styles.setNameButton, isThisSetExporting && styles.setNameButtonCompact, isBusy && { opacity: 0.5 }]}
                      onPress={() => handleSwitchSet(set.id)}
                      disabled={isBusy}
                    >
                      <Text style={[styles.setNameText, { color: colors.text }]} numberOfLines={1}>
                        {set.name}
                      </Text>
                      <Text style={[styles.setActiveBadge, { color: isActive ? colors.primary : colors.secondaryText }]}>
                        {isActive ? 'Active - loaded now' : 'Tap to load'}
                      </Text>
                      <Text style={[styles.setStorageText, { color: colors.secondaryText }]}>
                        {isCalculatingStorage ? '...' : formatBytes(storageBytesById[set.id] ?? 0)}
                      </Text>
                    </TouchableOpacity>
                    <View style={[styles.walletRowButtons, isThisSetExporting && styles.walletRowButtonsExporting]}>
                      {!isThisSetExporting ? (
                        <TouchableOpacity
                          style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                          onPress={() => handleStartRenameSet(set)}
                          disabled={isBusy}
                        >
                          <Text style={[styles.rowButtonText, { color: colors.text }]}>Rename</Text>
                        </TouchableOpacity>
                      ) : null}
                      {!IS_WEB ? (
                      <TouchableOpacity
                          style={[
                            styles.rowButton,
                            { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
                            isExportingId !== null && { opacity: 0.5 },
                            isThisSetExporting && styles.rowButtonFullWidth,
                          ]}
                          onPress={() => handleExportSet(set)}
                          disabled={isExportingId !== null || isImporting}
                        >
                          <Text
                            style={[styles.rowButtonText, { color: colors.text }, isThisSetExporting && styles.rowButtonTextCentered]}
                            numberOfLines={1}
                          >
                            {isExportingId === set.id ? (exportProgressLabel || 'Exporting...') : 'Export'}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                      {!isThisSetExporting ? (
                        <TouchableOpacity
                          style={[styles.rowButton, { backgroundColor: colors.statusFailedBackground }, isBusy && { opacity: 0.5 }]}
                          onPress={() => handleDeleteSet(set)}
                          disabled={isBusy}
                        >
                          <Text style={[styles.rowButtonText, { color: colors.cancelText }]}>Delete</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </>
                )}
              </View>
            );
          })}

        </View>

        {activeWalletSetId ? (
          <>
            <Text style={[styles.activeSetHeadline, { color: colors.text }]}>
              Wallets in "{activeSetName}"
            </Text>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.addRow}>
                <TextInput
                  style={[styles.addInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                  placeholder="Paste a Klever wallet address (klv1...)"
                  placeholderTextColor={colors.secondaryText}
                  value={newAddressInput}
                  onChangeText={setNewAddressInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                />
                <TouchableOpacity
                  style={[styles.scanButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                  onPress={() => setIsScannerVisible(true)}
                  disabled={isBusy}
                >
                  <Text style={styles.scanButtonIcon}>📷</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.addButton,
                    { backgroundColor: colors.primary },
                    (isBusy || newAddressInput.trim().length === 0) && { backgroundColor: colors.primaryDisabled },
                  ]}
                  onPress={handleAdd}
                  disabled={isBusy || newAddressInput.trim().length === 0}
                >
                  <Text style={[styles.addButtonText, { color: colors.primaryText }]}>Add</Text>
                </TouchableOpacity>
              </View>
              {IS_WEB ? (
                <TouchableOpacity
                  style={[
                    styles.extensionButton,
                    { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
                    (isBusy || isConnectingExtension) && { opacity: 0.5 },
                  ]}
                  onPress={handleConnectExtension}
                  disabled={isBusy || isConnectingExtension}
                >
                  <Text style={[styles.rowButtonText, { color: colors.text }]}>
                    {isConnectingExtension ? 'Connecting...' : 'Connect Klever Extension'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </KeyboardAvoidingView>

            <QrScannerModal
              visible={isScannerVisible}
              onScanned={handleScanned}
              onClose={() => setIsScannerVisible(false)}
            />
          </>
        ) : null}

        {!activeWalletSetId ? (
          <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
            No wallet set is loaded right now - load one above, or create a new one to start adding wallet addresses.
          </Text>
        ) : wallets.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
            No wallets added yet - paste an address above and tap Add.
          </Text>
        ) : (
          wallets.map((wallet) => (
            <View
              key={wallet.id}
              style={[styles.walletRow, { backgroundColor: colors.surface, shadowColor: colors.cardShadow }]}
            >
              {editingId === wallet.id ? (
                <>
                  <TextInput
                    style={[styles.editInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
                    value={editAddressInput}
                    onChangeText={setEditAddressInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isBusy}
                  />
                  {/* Optional friendly name - "Main", "Trading", etc. -
                      shown next to the Edit/Delete buttons once saved
                      (see the non-edit row below). */}
                  <TextInput
                    style={[styles.editInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
                    placeholder="Name this wallet (optional)"
                    placeholderTextColor={colors.secondaryText}
                    value={editAliasInput}
                    onChangeText={setEditAliasInput}
                    autoCapitalize="words"
                    editable={!isBusy}
                  />
                  <View style={styles.walletRowButtons}>
                    <TouchableOpacity
                      style={[
                        styles.rowButton,
                        { backgroundColor: colors.primary },
                        (isBusy || editAddressInput.trim().length === 0) && { backgroundColor: colors.primaryDisabled },
                      ]}
                      onPress={() => handleSaveEdit(wallet.id)}
                      disabled={isBusy || editAddressInput.trim().length === 0}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.primaryText }]}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                      onPress={handleCancelEdit}
                      disabled={isBusy}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.text }]}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text style={[styles.walletAddress, { color: colors.text }]} numberOfLines={1}>
                    {wallet.address}
                  </Text>
                  {/* Buttons on the left, the wallet's alias (if it has
                      one) on the right of them - a plain "name tag" so
                      wallets are easy to tell apart at a glance. */}
                  <View style={styles.walletRowBottom}>
                    <View style={styles.walletRowButtons}>
                      <TouchableOpacity
                        style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, isBusy && { opacity: 0.5 }]}
                        onPress={() => handleStartEdit(wallet)}
                        disabled={isBusy}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.text }]}>Edit</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.rowButton, { backgroundColor: colors.statusFailedBackground }, isBusy && { opacity: 0.5 }]}
                        onPress={() => handleDelete(wallet.id)}
                        disabled={isBusy}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.cancelText }]}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                    {wallet.alias ? (
                      <Text style={[styles.walletAlias, { color: colors.secondaryText }]} numberOfLines={1}>
                        {wallet.alias}
                      </Text>
                    ) : null}
                  </View>
                </>
              )}
            </View>
          ))
        )}

        {/* Separated from the wallet list above by its own border/
            spacing, and styled distinctly (red text/border) so it never
            gets mistaken for a normal action - this is the one button on
            this whole screen that erases data with no way to get it
            back. See handleResetAllData's own comment for why it exists
            at all. */}
        <View style={[styles.dangerZone, { borderTopColor: colors.border }]}>
          <View style={styles.dangerZoneHeader}>
            <Text style={[styles.dangerZoneTitle, { color: colors.text }]}>Danger zone</Text>
            <Switch
              value={isDangerZoneVisible}
              onValueChange={setIsDangerZoneVisible}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor={colors.surface}
            />
          </View>
          {isDangerZoneVisible ? (
            <>
              <Text style={[styles.dangerZoneText, { color: colors.secondaryText }]}>
                Wipes every wallet set, every saved wallet, and every stored NFT (and their downloaded images) - useful for testing the app again from a fresh start. Your actual NFTs on the blockchain are never affected. To clear out just one set instead, use its own Delete button above.
              </Text>
              <TouchableOpacity
                style={[styles.resetButton, { backgroundColor: colors.statusFailedBackground }, isBusy && { opacity: 0.5 }]}
                onPress={handleResetAllData}
                disabled={isBusy}
              >
                <Text style={[styles.resetButtonText, { color: colors.cancelText }]}>Reset All Data</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
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
    marginBottom: 16,
  },
  busyBanner: {
    fontSize: 13,
    fontWeight: '600',
    fontStyle: 'italic',
    marginHorizontal: 12,
    marginTop: -12,
    marginBottom: 16,
  },
  setSwitcherSection: {
    marginBottom: 8,
  },
  setSwitcherTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginHorizontal: 12,
    marginBottom: 4,
  },
  setSwitcherHint: {
    fontSize: 13,
    marginHorizontal: 12,
    marginBottom: 10,
  },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
    gap: 8,
  },
  setNameButton: {
    flex: 1,
  },
  // Shrinks the name/status/size block to just its own content width
  // while THIS set's export is running, so walletRowButtonsExporting
  // below can claim the rest of the row for the Export button instead
  // of the usual 50/50 flex split - see that style's own comment.
  setNameButtonCompact: {
    flex: 0,
  },
  setNameText: {
    fontSize: 14,
    fontWeight: '600',
  },
  setActiveBadge: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  setStorageText: {
    fontSize: 12,
    marginTop: 2,
  },
  setSwitcherStorageTotal: {
    fontSize: 12,
    marginHorizontal: 12,
    marginBottom: 10,
  },
  backupRow: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 10,
    gap: 8,
  },
  backupButton: {
    flex: 1,
    alignItems: 'center',
    // Same "flex item won't shrink below its own text" issue as
    // rowButtonFullWidth above - "Export all sets" shows this exact
    // growing progress label too, just wrapping onto a second line
    // (numberOfLines={2}) rather than overflowing sideways today, which
    // is closer to luck than a real guarantee. Cheap to close off here
    // too rather than wait for Raphael to hit it from this side.
    minWidth: 0,
  },
  newSetButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 10,
  },
  newSetButtonText: {
    fontWeight: '600',
  },
  // Sits right above the Add-wallet row (and, visually, the wallet list
  // in the ScrollView just below it too) - a plain section label, same
  // weight as setSwitcherTitle above, naming the active set by name so
  // it's unambiguous which set the Add row and the list beneath it
  // belong to, rather than reading as generic/unscoped.
  activeSetHeadline: {
    fontSize: 15,
    fontWeight: '700',
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    gap: 8,
  },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  scanButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButtonIcon: {
    fontSize: 18,
  },
  extensionButton: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  addButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addButtonText: {
    fontWeight: '600',
  },
  listContent: {
    paddingTop: 12,
    paddingBottom: 24,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 24,
    marginHorizontal: 12,
  },
  walletRow: {
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 10,
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  walletAddress: {
    fontSize: 14,
    marginBottom: 8,
  },
  editInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  walletRowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  walletRowButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  // Raphael's own request: while a set's own export is running, its
  // progress text keeps changing length ("Exporting..." -> "Reading
  // images... 5000/9098" -> ...), and a button sized to fit its own
  // content was visibly resizing/flickering on every update as a
  // result. Giving this container flex:1 (paired with
  // setNameButtonCompact above, which stops the name block competing
  // for the same space) and rowButtonFullWidth below on the button
  // itself means the button's own box size is now fixed by the row's
  // layout, not by whatever text happens to be in it right now - only
  // the text can change, never the border.
  walletRowButtonsExporting: {
    flex: 1,
    // React Native flex items default to a minimum width of "however
    // wide my content naturally wants to be," same long-standing quirk
    // as CSS flexbox on the web - so without this, the Export button's
    // own constantly-growing progress text ("Reading images...
    // 235/438") was winning a tug-of-war with flex:1 and pushing this
    // whole row wider than the tile itself, right off the edge of the
    // screen (Raphael's own report, screenshot in hand). minWidth: 0
    // is what actually lets this container shrink to fit the row
    // instead of the row stretching to fit it.
    minWidth: 0,
  },
  rowButton: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  rowButtonFullWidth: {
    flex: 1,
    alignItems: 'center',
    // Same fix as walletRowButtonsExporting's own comment just above,
    // one level down - the button itself also needs permission to
    // shrink below its text's natural width, or numberOfLines={1}'s
    // ellipsis never actually gets a chance to kick in.
    minWidth: 0,
  },
  rowButtonText: {
    fontWeight: '600',
    fontSize: 13,
  },
  rowButtonTextCentered: {
    textAlign: 'center',
  },
  walletAlias: {
    fontSize: 13,
    fontWeight: '600',
    fontStyle: 'italic',
    flexShrink: 1,
    textAlign: 'right',
  },
  dangerZone: {
    marginTop: 20,
    marginHorizontal: 12,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  dangerZoneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dangerZoneTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  dangerZoneText: {
    fontSize: 13,
    marginTop: 8,
    marginBottom: 10,
  },
  resetButton: {
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  resetButtonText: {
    fontWeight: '600',
  },
});
