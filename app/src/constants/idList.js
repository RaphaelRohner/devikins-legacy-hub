/**
 * idList.js
 *
 * "My wallets" (11 Oct 2026): one wallet set can be marked as the user's
 * own (WalletManager.js). That set also shows the NFTs on the Withdrawals
 * list - e.g. NFTs still in the game's main wallet - fetched by number.
 *
 * Inside the Hub those NFTs belong to a pretend wallet with this name, so
 * the existing fetch / retry / list code handles them like any wallet
 * (see fetchAllForWallet.js listNoncesForOwner). It never leaves the Hub
 * and is never sent anywhere.
 */
export const ID_LIST_OWNER = 'withdrawals-list';

// global setting: id of the wallet set marked "My wallets" (only one)
export const MY_WALLETS_SET_KEY = 'my_wallets_set_id';
