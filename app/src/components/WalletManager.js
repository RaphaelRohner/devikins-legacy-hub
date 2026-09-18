/**
 * WalletManager.js
 *
 * The "Wallets" screen, opened by the Wallets button next to Fetch/Update
 * in App.js. Lets the user manage the list of wallet addresses the app
 * fetches from - add a new one, edit an existing one (e.g. to fix a typo),
 * or remove one - the classic four CRUD operations (Create/Read/Update/
 * Delete), each one just a plain button, per the project's request.
 *
 * Like every other "screen" in this app (the NFT detail view in
 * CollectionView.js is the other example), this isn't a real navigation
 * stack - it's just App.js swapping what it renders based on a boolean
 * state flag (showWalletManager), with its own "‹ Back to Home" button to
 * swap back. See App.js's own file comment for why the whole app is built
 * this way instead of using a navigation library.
 *
 * This component doesn't keep its own copy of the wallet list - it always
 * shows exactly the `wallets` array App.js passes in, and calls
 * `onWalletsChanged` after every add/edit/delete so App.js can reload that
 * list from the database and pass the fresh version back down. That keeps
 * "what wallets exist" living in exactly one place (the database, read
 * through App.js) rather than two copies that could drift out of sync.
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
} from 'react-native';
import { addWallet, updateWalletAddress, deleteWallet, resetAllData } from '../db/database';
import { deleteAllStoredImages } from '../api/imageStorage';
import { useTheme } from '../context/ThemeContext';

export default function WalletManager({ wallets, onWalletsChanged, onClose }) {
  const { colors } = useTheme();

  // The "Add a wallet" text field at the top.
  const [newAddressInput, setNewAddressInput] = useState('');

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

  // Wipes every wallet and every saved NFT, back to exactly what a
  // brand-new install looks like - mainly a testing convenience (so the
  // whole app can be exercised again "from scratch" without uninstalling
  // Expo Go, which would wipe every OTHER Expo Go project on this phone
  // too, not just this one). Unlike deleting a single wallet above, this
  // DOES permanently erase NFT data (and every downloaded image), so it
  // gets an actual confirmation prompt first, matching how destructive an
  // action it really is.
  function handleResetAllData() {
    Alert.alert(
      'Reset all data?',
      'This deletes every saved wallet and every Devikin, Weapon, and Equipment NFT stored on this phone, along with their downloaded images. This cannot be undone - your actual NFTs are safe on the blockchain either way, but you will need to re-add your wallet(s) and fetch again from scratch.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything',
          style: 'destructive',
          onPress: async () => {
            await resetAllData();
            await deleteAllStoredImages();
            onWalletsChanged();
          },
        },
      ]
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }]}
        onPress={onClose}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹ Back to Home</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Wallets</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        Fetch/Update pulls Devikins, Weapons, and Equipment from every wallet address listed here.
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

      <ScrollView contentContainerStyle={styles.listContent}>
        {wallets.length === 0 ? (
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
          <Text style={[styles.dangerZoneTitle, { color: colors.text }]}>Danger zone</Text>
          <Text style={[styles.dangerZoneText, { color: colors.secondaryText }]}>
            Wipes every saved wallet and every stored NFT (and their downloaded images) - useful for testing the app again from a fresh start. Your actual NFTs on the blockchain are never affected.
          </Text>
          <TouchableOpacity
            style={[styles.resetButton, { backgroundColor: colors.statusFailedBackground }]}
            onPress={handleResetAllData}
          >
            <Text style={[styles.resetButtonText, { color: colors.cancelText }]}>Reset All Data</Text>
          </TouchableOpacity>
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
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginVertical: 12,
    alignSelf: 'flex-start',
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: '600',
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
  dangerZoneTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  dangerZoneText: {
    fontSize: 13,
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
