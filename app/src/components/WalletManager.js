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
 * When no set is active at all (the "Empty" action was used - see
 * handleEmptySet below), the Add row and wallet list are replaced with
 * a short explanation instead of rendering against data that doesn't
 * exist - see the `activeWalletSetId` check partway through this file.
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

import { useState } from 'react';
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
} from 'react-native';
import {
  addWallet,
  updateWalletAddress,
  deleteWallet,
  resetAllData,
  createWalletSet,
  renameWalletSet,
  switchToWalletSet,
  unloadCurrentWalletSet,
  deleteWalletSet,
} from '../db/database';
import { useTheme } from '../context/ThemeContext';
import QrScannerModal from './QrScannerModal';

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

  // Unloads the currently active set without touching any of its data -
  // Raphael's own "Empty" action (see unloadCurrentWalletSet's own
  // comment in database.js). No confirmation dialog, same reasoning as
  // handleDelete above for a single wallet: nothing is actually erased,
  // so there's nothing risky to confirm - the set stays in the switcher
  // list below, ready to load back in any time.
  async function handleEmptySet() {
    try {
      await unloadCurrentWalletSet();
      onWalletSetsChanged();
    } catch (err) {
      reportSetActionError(err, 'Emptying that set');
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
  const activeSet = walletSets.find((set) => set.id === activeWalletSetId);
  const activeSetName = activeSet ? activeSet.name : '';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }]}
        onPress={onClose}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Wallets</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        Fetch/Update pulls Devikins, Weapons, and Equipment from every wallet address listed here.
      </Text>

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
            />
            <TouchableOpacity
              style={[styles.addButton, { backgroundColor: colors.primary }]}
              onPress={handleCreateSet}
            >
              <Text style={[styles.addButtonText, { color: colors.primaryText }]}>Create</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
              onPress={handleCancelCreateSet}
            >
              <Text style={[styles.rowButtonText, { color: colors.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.newSetButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
            onPress={() => setIsCreatingSet(true)}
          >
            <Text style={[styles.newSetButtonText, { color: colors.text }]}>+ New set</Text>
          </TouchableOpacity>
        )}

        {walletSets.map((set) => {
          const isActive = set.id === activeWalletSetId;
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
                  />
                  <View style={styles.walletRowButtons}>
                    <TouchableOpacity
                      style={[
                        styles.rowButton,
                        { backgroundColor: colors.primary },
                        renameSetInput.trim().length === 0 && { backgroundColor: colors.primaryDisabled },
                      ]}
                      onPress={() => handleSaveRenameSet(set.id)}
                      disabled={renameSetInput.trim().length === 0}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.primaryText }]}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
                      onPress={handleCancelRenameSet}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.text }]}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <TouchableOpacity style={styles.setNameButton} onPress={() => handleSwitchSet(set.id)}>
                    <Text style={[styles.setNameText, { color: colors.text }]} numberOfLines={1}>
                      {set.name}
                    </Text>
                    <Text style={[styles.setActiveBadge, { color: isActive ? colors.primary : colors.secondaryText }]}>
                      {isActive ? 'Active - loaded now' : 'Tap to load'}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.walletRowButtons}>
                    <TouchableOpacity
                      style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
                      onPress={() => handleStartRenameSet(set)}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.text }]}>Rename</Text>
                    </TouchableOpacity>
                    {isActive ? (
                      <TouchableOpacity
                        style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
                        onPress={handleEmptySet}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.text }]}>Empty</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={[styles.rowButton, { backgroundColor: colors.statusFailedBackground }]}
                      onPress={() => handleDeleteSet(set)}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.cancelText }]}>Delete</Text>
                    </TouchableOpacity>
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
              />
              <TouchableOpacity
                style={[styles.scanButton, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
                onPress={() => setIsScannerVisible(true)}
              >
                <Text style={styles.scanButtonIcon}>📷</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.addButton,
                  { backgroundColor: colors.primary },
                  newAddressInput.trim().length === 0 && { backgroundColor: colors.primaryDisabled },
                ]}
                onPress={handleAdd}
                disabled={newAddressInput.trim().length === 0}
              >
                <Text style={[styles.addButtonText, { color: colors.primaryText }]}>Add</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>

          <QrScannerModal
            visible={isScannerVisible}
            onScanned={handleScanned}
            onClose={() => setIsScannerVisible(false)}
          />
        </>
      ) : null}

      <ScrollView contentContainerStyle={styles.listContent}>
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
                  />
                  <View style={styles.walletRowButtons}>
                    <TouchableOpacity
                      style={[
                        styles.rowButton,
                        { backgroundColor: colors.primary },
                        editAddressInput.trim().length === 0 && { backgroundColor: colors.primaryDisabled },
                      ]}
                      onPress={() => handleSaveEdit(wallet.id)}
                      disabled={editAddressInput.trim().length === 0}
                    >
                      <Text style={[styles.rowButtonText, { color: colors.primaryText }]}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
                      onPress={handleCancelEdit}
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
                        style={[styles.rowButton, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }]}
                        onPress={() => handleStartEdit(wallet)}
                      >
                        <Text style={[styles.rowButtonText, { color: colors.text }]}>Edit</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.rowButton, { backgroundColor: colors.statusFailedBackground }]}
                        onPress={() => handleDelete(wallet.id)}
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
                style={[styles.resetButton, { backgroundColor: colors.statusFailedBackground }]}
                onPress={handleResetAllData}
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
  setNameText: {
    fontSize: 14,
    fontWeight: '600',
  },
  setActiveBadge: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
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
  addButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addButtonText: {
    fontWeight: '600',
  },
  listContent: {
    padding: 12,
    paddingBottom: 24,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 24,
  },
  walletRow: {
    borderRadius: 10,
    padding: 12,
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
  rowButton: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  rowButtonText: {
    fontWeight: '600',
    fontSize: 13,
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
